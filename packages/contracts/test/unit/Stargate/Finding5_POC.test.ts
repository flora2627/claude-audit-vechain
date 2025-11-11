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

describe("Finding 5: Double Decrease Effective Stake on Exit", () => {
    const VTHO_TOKEN_ADDRESS = "0x0000000000000000000000000000456E65726779";
    let stargateContract: Stargate;
    let stargateNFTMock: StargateNFTMock;
    let protocolStakerMock: ProtocolStakerMock;
    let legacyNodesMock: TokenAuctionMock;
    let deployer: HardhatEthersSigner;
    let user: HardhatEthersSigner;
    let validator: HardhatEthersSigner;
    let tx: TransactionResponse;
    let vthoTokenContract: MyERC20;

    const LEVEL_ID = 1;
    const VALIDATOR_STATUS_QUEUED = 1;
    const VALIDATOR_STATUS_ACTIVE = 2;
    const VALIDATOR_STATUS_EXITED = 3;
    const DELEGATION_STATUS_PENDING = 1;
    const DELEGATION_STATUS_ACTIVE = 2;

    beforeEach(async () => {
        const config = createLocalConfig();
        [deployer] = await ethers.getSigners();

        // Deploy protocol staker mock
        const protocolStakerMockFactory = new ProtocolStakerMock__factory(deployer);
        protocolStakerMock = await protocolStakerMockFactory.deploy();
        await protocolStakerMock.waitForDeployment();

        // Deploy stargateNFT mock
        const stargateNFTMockFactory = new StargateNFTMock__factory(deployer);
        stargateNFTMock = await stargateNFTMockFactory.deploy();
        await stargateNFTMock.waitForDeployment();

        // Deploy VTHO token to the energy address
        const vthoTokenContractFactory = new MyERC20__factory(deployer);
        const tokenContract = await vthoTokenContractFactory.deploy(
            deployer.address,
            deployer.address
        );
        await tokenContract.waitForDeployment();
        const tokenContractBytecode = await ethers.provider.getCode(tokenContract);
        await ethers.provider.send("hardhat_setCode", [VTHO_TOKEN_ADDRESS, tokenContractBytecode]);

        // Deploy legacy nodes mock
        const legacyNodesMockFactory = new TokenAuctionMock__factory(deployer);
        legacyNodesMock = await legacyNodesMockFactory.deploy();
        await legacyNodesMock.waitForDeployment();

        // Deploy contracts
        config.PROTOCOL_STAKER_CONTRACT_ADDRESS = await protocolStakerMock.getAddress();
        config.STARGATE_NFT_CONTRACT_ADDRESS = await stargateNFTMock.getAddress();
        const contracts = await getOrDeployContracts({ forceDeploy: true, config });
        stargateContract = contracts.stargateContract;
        vthoTokenContract = MyERC20__factory.connect(VTHO_TOKEN_ADDRESS, deployer);
        
        user = contracts.otherAccounts[0];
        validator = contracts.otherAccounts[2];

        // Add validator
        tx = await protocolStakerMock.addValidation(validator.address, 120);
        await tx.wait();

        // Set the stargate contract address for withdrawals
        tx = await protocolStakerMock.helper__setStargate(stargateContract.target);
        await tx.wait();
        
        // Set validator status to ACTIVE
        tx = await protocolStakerMock.helper__setValidatorStatus(
            validator.address,
            VALIDATOR_STATUS_ACTIVE
        );
        await tx.wait();

        // Configure level in stargateNFTMock
        tx = await stargateNFTMock.helper__setLevel({
            id: LEVEL_ID,
            name: "Strength",
            isX: false,
            maturityBlocks: 10,
            scaledRewardFactor: 150,
            vetAmountRequiredToStake: ethers.parseEther("1"),
        });
        await tx.wait();

        // Mint VTHO to stargate contract for rewards
        tx = await vthoTokenContract
            .connect(deployer)
            .mint(stargateContract, ethers.parseEther("50000000"));
        await tx.wait();
    });

    describe("Validator exits network after user requests exit", () => {
        it("should revert unstake due to double effective stake decrease", async () => {
            const levelSpec = await stargateNFTMock.getLevel(LEVEL_ID);
            const stakeAmount = levelSpec.vetAmountRequiredToStake;

            // Setup: Stake and delegate
            tx = await stargateContract.connect(user).stake(LEVEL_ID, { value: stakeAmount });
            await tx.wait();
            const tokenId = await stargateNFTMock.getCurrentTokenId();

            tx = await stargateNFTMock.helper__setToken({
                tokenId: tokenId,
                levelId: LEVEL_ID,
                mintedAtBlock: 0,
                vetAmountStaked: stakeAmount,
                lastVetGeneratedVthoClaimTimestamp_deprecated: 0,
            });
            await tx.wait();
            tx = await stargateNFTMock.helper__setLegacyNodes(legacyNodesMock);
            await tx.wait();

            tx = await protocolStakerMock.helper__setValidationCompletedPeriods(validator.address, 0);
            await tx.wait();

            tx = await stargateContract.connect(user).delegate(tokenId, validator.address);
            await tx.wait();

            // Make delegation ACTIVE
            tx = await protocolStakerMock.helper__setValidationCompletedPeriods(validator.address, 2);
            await tx.wait();

            const delegation = await stargateContract.getDelegationDetails(tokenId);
            expect(delegation.status).to.equal(DELEGATION_STATUS_ACTIVE);

            // User requests exit (first decrease executed here)
            tx = await stargateContract.connect(user).requestDelegationExit(tokenId);
            await tx.wait();

            // Validator exits network
            tx = await protocolStakerMock.helper__setValidatorStatus(validator.address, VALIDATOR_STATUS_EXITED);
            await tx.wait();

            const [, , , , validatorStatus] = await protocolStakerMock.getValidation(validator.address);
            expect(validatorStatus).to.equal(VALIDATOR_STATUS_EXITED);

            // Attempting unstake should revert (second decrease causes underflow)
            await expect(stargateContract.connect(user).unstake(tokenId)).to.be.reverted;

            // Verify funds are locked
            const delegationId = await stargateContract.getDelegationIdOfToken(tokenId);
            const [, delStake] = await protocolStakerMock.getDelegation(delegationId);
            const token = await stargateNFTMock.getToken(tokenId);
            
            console.log(`Locked stake: ${ethers.formatEther(delStake)} VET`);
            console.log(`Protocol debt: ${ethers.formatEther(token.vetAmountStaked)} VET`);
        });
    });

    describe("Validator status changes to QUEUED after user requests exit", () => {
        it("should revert unstake when delegation becomes PENDING", async () => {
            const levelSpec = await stargateNFTMock.getLevel(LEVEL_ID);
            const stakeAmount = levelSpec.vetAmountRequiredToStake;

            // Setup: Stake and delegate
            tx = await stargateContract.connect(user).stake(LEVEL_ID, { value: stakeAmount });
            await tx.wait();
            const tokenId = await stargateNFTMock.getCurrentTokenId();

            tx = await stargateNFTMock.helper__setToken({
                tokenId: tokenId,
                levelId: LEVEL_ID,
                mintedAtBlock: 0,
                vetAmountStaked: stakeAmount,
                lastVetGeneratedVthoClaimTimestamp_deprecated: 0,
            });
            await tx.wait();
            tx = await stargateNFTMock.helper__setLegacyNodes(legacyNodesMock);
            await tx.wait();

            tx = await protocolStakerMock.helper__setValidationCompletedPeriods(validator.address, 0);
            await tx.wait();

            tx = await stargateContract.connect(user).delegate(tokenId, validator.address);
            await tx.wait();

            // Make delegation ACTIVE
            tx = await protocolStakerMock.helper__setValidationCompletedPeriods(validator.address, 2);
            await tx.wait();

            // User requests exit (first decrease)
            tx = await stargateContract.connect(user).requestDelegationExit(tokenId);
            await tx.wait();

            // Validator becomes QUEUED (delegation becomes PENDING)
            tx = await protocolStakerMock.helper__setValidatorStatus(validator.address, VALIDATOR_STATUS_QUEUED);
            await tx.wait();

            const [, , , , validatorStatus] = await protocolStakerMock.getValidation(validator.address);
            expect(validatorStatus).to.equal(VALIDATOR_STATUS_QUEUED);

            const delegation = await stargateContract.getDelegationDetails(tokenId);
            console.log(`Delegation status: ${delegation.status} (PENDING)`);

            // Attempting unstake should revert (second decrease via PENDING check)
            await expect(stargateContract.connect(user).unstake(tokenId)).to.be.reverted;
        });
    });

    describe("User cannot re-delegate after exit request when validator exits", () => {
        it("should revert re-delegation due to double effective stake decrease", async () => {
            // Setup second validator
            const otherValidator = (await ethers.getSigners())[3];
            tx = await protocolStakerMock.addValidation(otherValidator.address, 120);
            await tx.wait();
            tx = await protocolStakerMock.helper__setValidatorStatus(otherValidator.address, VALIDATOR_STATUS_ACTIVE);
            await tx.wait();

            const levelSpec = await stargateNFTMock.getLevel(LEVEL_ID);
            const stakeAmount = levelSpec.vetAmountRequiredToStake;

            // Setup: Stake and delegate to validator 1
            tx = await stargateContract.connect(user).stake(LEVEL_ID, { value: stakeAmount });
            await tx.wait();
            const tokenId = await stargateNFTMock.getCurrentTokenId();

            tx = await stargateNFTMock.helper__setToken({
                tokenId: tokenId,
                levelId: LEVEL_ID,
                mintedAtBlock: 0,
                vetAmountStaked: stakeAmount,
                lastVetGeneratedVthoClaimTimestamp_deprecated: 0,
            });
            await tx.wait();
            tx = await stargateNFTMock.helper__setLegacyNodes(legacyNodesMock);
            await tx.wait();

            tx = await protocolStakerMock.helper__setValidationCompletedPeriods(validator.address, 0);
            await tx.wait();

            tx = await stargateContract.connect(user).delegate(tokenId, validator.address);
            await tx.wait();

            // User requests exit (first decrease)
            tx = await stargateContract.connect(user).requestDelegationExit(tokenId);
            await tx.wait();

            // Validator 1 exits network
            tx = await protocolStakerMock.helper__setValidatorStatus(validator.address, VALIDATOR_STATUS_EXITED);
            await tx.wait();

            // Attempting to re-delegate should revert (delegate() also has double decrease logic)
            await expect(stargateContract.connect(user).delegate(tokenId, otherValidator.address)).to.be.reverted;

            console.log("User cannot unstake OR re-delegate - funds permanently locked");
        });
    });
});

