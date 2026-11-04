// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Thin operator for Base AuthCaptureEscrow. This contract does not hold USDC.
/// The escrow's PaymentInfo.operator is this contract. capture and void succeed only
/// when the supervisor signature covers the task id, verdict, and artifact CID.
interface IAuthCaptureEscrow {
    struct PaymentInfo {
        address operator;
        address payer;
        address receiver;
        address token;
        uint120 maxAmount;
        uint48 preApprovalExpiry;
        uint48 authorizationExpiry;
        uint48 refundExpiry;
        uint16 minFeeBps;
        uint16 maxFeeBps;
        address feeReceiver;
        uint256 salt;
    }

    function capture(PaymentInfo calldata paymentInfo, uint256 amount, uint256 feeAmount, address feeReceiver) external;

    function void(PaymentInfo calldata paymentInfo) external;
}

contract MuselancerOperator {
    address public immutable supervisor;
    IAuthCaptureEscrow public immutable escrow;

    event Settled(string taskId, string verdict, string artifactCid, bool captured);

    error BadSupervisor();

    constructor(address supervisor_, address escrow_) {
        supervisor = supervisor_;
        escrow = IAuthCaptureEscrow(escrow_);
    }

    function captureIfPass(
        IAuthCaptureEscrow.PaymentInfo calldata paymentInfo,
        uint256 amount,
        string calldata taskId,
        string calldata artifactCid,
        bytes calldata signature
    ) external {
        _check(taskId, "pass", artifactCid, signature);
        escrow.capture(paymentInfo, amount, 0, address(0));
        emit Settled(taskId, "pass", artifactCid, true);
    }

    function voidIfFail(
        IAuthCaptureEscrow.PaymentInfo calldata paymentInfo,
        string calldata taskId,
        string calldata artifactCid,
        bytes calldata signature
    ) external {
        _check(taskId, "fail", artifactCid, signature);
        escrow.void(paymentInfo);
        emit Settled(taskId, "fail", artifactCid, false);
    }

    function _check(string calldata taskId, string memory verdict, string calldata artifactCid, bytes calldata signature) internal view {
        bytes32 digest = keccak256(abi.encodePacked("MuselancerOperator.v1", taskId, verdict, artifactCid));
        bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        address recovered = _recover(ethHash, signature);
        if (recovered != supervisor) revert BadSupervisor();
    }

    function _recover(bytes32 hash, bytes calldata signature) internal pure returns (address) {
        if (signature.length != 65) revert BadSupervisor();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        return ecrecover(hash, v, r, s);
    }
}
