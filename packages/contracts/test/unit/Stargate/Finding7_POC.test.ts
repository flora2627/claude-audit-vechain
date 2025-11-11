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

describe("Finding 7: Validator UNKNOWN leaves residual effective stake", () => {
    const VTHO_TOKEN_ADDRESS = "0x0000000000000000000000000000456E65726779";
    const LEVEL_ID = 1;
    const VALIDATOR_STATUS_UNKNOWN = 0;
    const VALIDATOR_STATUS_ACTIVE = 2;

    let stargateContract: Stargate;
    let stargateNFTMock: StargateNFTMock;
    let protocolStakerMock: ProtocolStakerMock;
    let legacyNodesMock: TokenAuctionMock;
    let vthoTokenContract: MyERC20;
    let deployer: HardhatEthersSigner;
    let exitingUser: HardhatEthersSigner;
    let victimUser: HardhatEthersSigner;
    let validator: HardhatEthersSigner;
    let tx: TransactionResponse;

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
        const tokenContract = await vthoTokenContractFactory.deploy(
            deployer.address,
            deployer.address
        );
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

        exitingUser = contracts.otherAccounts[0];
        victimUser = contracts.otherAccounts[1];
        validator = contracts.otherAccounts[2];

        tx = await protocolStakerMock.addValidation(validator.address, 120);
        await tx.wait();
        tx = await protocolStakerMock.helper__setStargate(stargateContract.target);
        await tx.wait();
        tx = await protocolStakerMock.helper__setValidatorStatus(
            validator.address,
            VALIDATOR_STATUS_ACTIVE
        );
        await tx.wait();

        tx = await stargateNFTMock.helper__setLevel({
            id: LEVEL_ID,
            name: "Strength",
            isX: false,
            maturityBlocks: 10,
            scaledRewardFactor: 100,
            vetAmountRequiredToStake: ethers.parseEther("1"),
        });
        await tx.wait();
        tx = await stargateNFTMock.helper__setToken({
            tokenId: 10000,
            levelId: LEVEL_ID,
            mintedAtBlock: 0,
            vetAmountStaked: ethers.parseEther("1"),
            lastVetGeneratedVthoClaimTimestamp_deprecated: 0,
        });
        await tx.wait();
        tx = await stargateNFTMock.helper__setLegacyNodes(legacyNodesMock);
        await tx.wait();

        tx = await vthoTokenContract
            .connect(deployer)
            .mint(stargateContract, ethers.parseEther("1000000"));
        await tx.wait();
    });

    it("dilutes honest delegators after validator becomes UNKNOWN", async () => {
        const levelSpec = await stargateNFTMock.getLevel(LEVEL_ID);
        const stakeAmount = levelSpec.vetAmountRequiredToStake;

        tx = await stargateContract.connect(exitingUser).stake(LEVEL_ID, { value: stakeAmount });
        await tx.wait();
        const exitingTokenId = await stargateNFTMock.getCurrentTokenId();
        tx = await stargateNFTMock.helper__setToken({
            tokenId: exitingTokenId,
            levelId: LEVEL_ID,
            mintedAtBlock: 0,
            vetAmountStaked: stakeAmount,
            lastVetGeneratedVthoClaimTimestamp_deprecated: 0,
        });
        await tx.wait();
        tx = await stargateContract.connect(exitingUser).delegate(exitingTokenId, validator.address);
        await tx.wait();

        tx = await stargateContract.connect(victimUser).stake(LEVEL_ID, { value: stakeAmount });
        await tx.wait();
        const victimTokenId = await stargateNFTMock.getCurrentTokenId();
        tx = await stargateNFTMock.helper__setToken({
            tokenId: victimTokenId,
            levelId: LEVEL_ID,
            mintedAtBlock: 0,
            vetAmountStaked: stakeAmount,
            lastVetGeneratedVthoClaimTimestamp_deprecated: 0,
        });
        await tx.wait();
        tx = await stargateContract.connect(victimUser).delegate(victimTokenId, validator.address);
        await tx.wait();

        tx = await protocolStakerMock.helper__setValidationCompletedPeriods(validator.address, 5);
        await tx.wait();

        const probePeriod = 10n;
        const totalEffectiveBeforeExit = await stargateContract.getDelegatorsEffectiveStake(
            validator.address,
            probePeriod
        );
        expect(totalEffectiveBeforeExit).to.equal(stakeAmount * 2n);

        tx = await protocolStakerMock.helper__setValidatorStatus(
            validator.address,
            VALIDATOR_STATUS_UNKNOWN
        );
        await tx.wait();

        await expect(stargateContract.connect(exitingUser).unstake(exitingTokenId)).to.not.be
            .reverted;

        const totalEffectiveAfterExit = await stargateContract.getDelegatorsEffectiveStake(
            validator.address,
            probePeriod
        );
        expect(totalEffectiveAfterExit).to.equal(stakeAmount * 2n);

        const remainingEffectiveStake = await stargateContract.getEffectiveStake(victimTokenId);
        expect(remainingEffectiveStake).to.equal(stakeAmount);

        const [firstClaimable, lastClaimable] =
            await stargateContract.claimableDelegationPeriods(victimTokenId);
        expect(lastClaimable).to.be.at.least(
            firstClaimable,
            "victim should have claimable periods"
        );

        const periodCount =
            lastClaimable >= firstClaimable ? lastClaimable - firstClaimable + 1n : 0n;
        expect(periodCount).to.be.greaterThan(0n);
        const perPeriodReward = ethers.parseEther("0.1");
        const totalRewards = periodCount * perPeriodReward;

        const claimable = await stargateContract.callStatic.claimableRewards(victimTokenId);
        expect(claimable).to.be.greaterThan(0n);
        expect(claimable * 2n).to.equal(
            totalRewards,
            "victim only receives a fraction of period rewards"
        );

        const victimBalanceBefore = await vthoTokenContract.balanceOf(victimUser.address);
        await expect(stargateContract.connect(victimUser).claimRewards(victimTokenId)).to.not.be
            .reverted;
        const victimBalanceAfter = await vthoTokenContract.balanceOf(victimUser.address);
        const claimedAmount = victimBalanceAfter - victimBalanceBefore;
        expect(claimedAmount).to.equal(claimable);

        const expectedLoss = totalRewards - claimable;
        expect(expectedLoss).to.be.greaterThan(0n);
        expect(expectedLoss).to.equal(claimable);
    });
});

