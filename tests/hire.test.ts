import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { PrivyClient } from "@privy-io/server-auth";
import { decodeFunctionData, getAddress, hashTypedData, keccak256, toBytes, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  AUTH_CAPTURE_ESCROW,
  ERC3009_COLLECTOR,
  USDC_BASE_SEPOLIA,
  X402_EXACT_PERMIT2_PROXY,
} from "../lib/chain/constants";
import {
  PAYMENT_INFO_TYPE,
  PAYMENT_INFO_TYPEHASH,
  authCaptureAbi,
  authorizeCall,
  buildHireLock,
  captureCall,
  erc3009Nonce,
  escrowPaymentHash,
  fallbackUsdcDomain,
  hireRequirement,
  receiveMessage,
  receiveWithAuthorizationTypes,
  voidCall,
} from "../lib/chain/commerce";
import { appendConfirmedFact, assertProfileOwner, blankProfile, saveCharacter, withProposal, workerTaskText } from "../lib/agent/profile";
import { deleteDocument, readDocument, writeDocument } from "../lib/db";
import { cancelOnlyHire, decideHireContinuation, leavesCurrentDeal, ownerDeadlineMs, parseOfferAmount, statedDeadline, usableWorkQuestion, wantsFreshHire, workerAcceptsOffer } from "../lib/deal/owner-turn";
import { authorizationPublicKey } from "../lib/server/supervisor-deploy";
import { controlIdentity, ownerControls } from "../lib/deal/actions";
import { briefJudgmentInstruction, clarifyGate, dealMessages, dealWorkText, deliveryFileKind, negotiationInstruction, relayDecision, scopeGate, scopeInstruction } from "../lib/deal/thread";
import {
  agreedLockAmount,
  assertListedSuggestion,
  assessPrice,
  counterLoosens,
  nextSuggestion,
  offerInsideLimits,
  reviewDeadline,
  capabilityRosterLines,
  bestWorkerInstruction,
  capabilitySkillInstruction,
  chosenWorkerId,
  descriptionFit,
  promoteChosenWorker,
  rankBySkillAndDescription,
  workerReason,
  coverageReasons,
  rankByCapabilities,
  rankByCapabilityCoverage,
  roomForRound,
  skillCoverRank,
  skillIdsFromModel,
} from "../lib/deal/rules";
import { hireProgress, jobLogLine, shouldStartWorker, taskPollWait } from "../lib/deal/progress";
import { hireStatusReport } from "../lib/deal/status-report";
import { preferHireState } from "../lib/server/hire-status";
import { conversationModel, performsTasks, taskRefusal } from "../lib/gateway/models";
import { assertModel, sparkStructured } from "../lib/gateway/meta";
import { writeMemoryHead } from "../lib/memory/head";
import { createMailboxKey, sealTo } from "../lib/messaging/seal";
import { acceptOwnerEnvelope, agentPublicSpki } from "../lib/messaging/thread";
import { buildDirectoryRecord } from "../lib/protocol/directory-record";
import { buildOasfRecord, validateOasf } from "../lib/protocol/oasf";
import { appOrigin } from "../lib/protocol/origin";
import { defaultPolicy, evaluatePolicy } from "../lib/protocol/policy";
import { buildOnchainRegistration, decodeDataJson } from "../lib/protocol/registration";
import { assertCommercialTerms, formatUsdc, parseUsdc, usdcLockRefusal } from "../lib/protocol/usdc";
import { ownerCallRefusal } from "../lib/chain/owner-call";
import { sandboxFailure } from "../lib/server/modal-job";
import { closeTaskBudget, loadTaskBudget, openTaskBudget, saveTaskBudget } from "../lib/server/budget";
import { scannerBlocksSeal } from "../lib/gateway/llama";
import { desk, saveDesk, withDesk } from "../lib/server/desk";
import { ensureArtifactKey, jobPrompt, referenceSkillFiles, runHireJob, runJobTurns, JOB_TURN_CAP } from "../lib/server/hire-job";
import { applyVerifiedVerdict, assertHireSignature, readReleasedDelivery, settlementCall, supervisorNote } from "../lib/server/hire";
import { acceptSupervisorReport, acceptSupervisorSuggestion, supervisorGuidance, supervisorJobFiles, supervisorSuggestionNote } from "../lib/server/supervisor-report";
import { isPlatformSupervisor } from "../lib/server/supervisor-id";
import { sealedToSupervisor, supervisorSeat } from "../lib/server/supervisor-seat";
import { serverReadiness } from "../lib/server/readiness";
import { freshAccount, memoryKey, Network } from "../lib/world/network";

process.env.MUSELANCER_DB ??= ":memory:";
process.env.SUPERVISOR_PRIVATE_KEY ??= `0x${"11".repeat(32)}`;

const policy = {
  ...defaultPolicy(),
  allowedActions: ["discover", "message", "hire", "deliver", "pay"],
  perTaskCapUsdc: "5000000",
  dailyBudgetUsdc: "5000000",
  allowedRecipients: [AUTH_CAPTURE_ESCROW.toLowerCase()],
};

function sampleLock() {
  const payer = privateKeyToAccount(generatePrivateKey());
  const receiver = privateKeyToAccount(generatePrivateKey());
  const operator = privateKeyToAccount(generatePrivateKey());
  const lock = buildHireLock({
    payer: payer.address,
    receiver: receiver.address,
    amount: "5000000",
    operator: operator.address,
    now: 1_700_000_000,
    salt: `0x${"ab".repeat(32)}`,
  });
  return { payer, receiver, operator, lock };
}

test("USDC amounts keep 6 decimals and the hire price stays inside the caps", () => {
  assert.equal(parseUsdc("5"), "5000000");
  assert.equal(parseUsdc("0.000001"), "1");
  assert.equal(parseUsdc("0005.50"), "5500000");
  assert.equal(formatUsdc("5000000"), "5");
  assert.equal(formatUsdc(parseUsdc("1.230000")), "1.23");
  assert.throws(() => parseUsdc("1.0000001"), /6 decimals/);
  assert.throws(() => parseUsdc("-1"), /6 decimals/);
  assert.throws(() => parseUsdc(""), /6 decimals/);
  assert.throws(() => parseUsdc("0"), /greater than zero/);
  assert.throws(() => assertCommercialTerms("6", "5", "10"), /per-task cap/);
  assert.throws(() => assertCommercialTerms("1", "6", "5"), /daily budget/);
  const saved = assertCommercialTerms("4.5", "5", "9");
  assert.equal(saved.hirePriceUsdc, "4500000");
  assert.equal(saved.perTaskCapUsdc, "5000000");
  assert.equal(saved.dailyBudgetUsdc, "9000000");
  assert.equal(usdcLockRefusal(BigInt(0), "5000000"), "The owner wallet holds 0 USDC. This lock needs 5 USDC. No USDC has moved.");
  assert.equal(usdcLockRefusal(BigInt(5000000), "5000000"), null);
  const reverted = { details: "ERC20: transfer amount exceeds balance", message: "Execution reverted URL: https://rpc.example/?privyAppId=secret" };
  assert.equal(ownerCallRefusal(reverted), "The owner wallet does not hold enough USDC for this lock. No USDC has moved.");
  assert.equal(ownerCallRefusal({ details: "intrinsic gas too low URL: https://rpc.example" }).includes("http"), false);
  assert.equal(shouldStartWorker({ status: "authorized", artifactCid: null, jobError: "" }), true);
  assert.equal(shouldStartWorker({ status: "authorized", artifactCid: null, jobError: "The sandbox stopped before a delivery." }), false);
  assert.equal(shouldStartWorker({ status: "authorized", artifactCid: null, jobError: "The command is not a program and arguments." }), true);
  assert.equal(shouldStartWorker({ status: "authorized", artifactCid: null, jobError: "Lookup failed for Function 'run_job' from the 'muselancer' app." }), true);
  assert.equal(sandboxFailure("modal.exception.NotFoundError: Lookup failed for Function 'run_job'").message, "The hire sandbox is not deployed. No USDC has moved.");
  assert.equal(shouldStartWorker({ status: "running", artifactCid: null, jobError: "" }), false);
  const line = jobLogLine({ turn: 1, paths: ["index.html"], command: [], output: "", done: true });
  assert.match(line, /Wrote index.html/);
  assert.equal(line.includes("<p>Hello</p>"), false);
  const starting = hireProgress({ paymentStatus: "authorized", taskStatus: "authorized", hasArtifact: false, reviewed: false, jobError: "" });
  assert.equal(starting.working, false);
  assert.match(starting.headline, /worker is starting/);
  const working = hireProgress({ paymentStatus: "authorized", taskStatus: "running", hasArtifact: false, reviewed: false, jobError: "" });
  assert.equal(working.working, true);
  assert.equal(working.stages[1]?.state, "now");
  const sealed = hireProgress({ paymentStatus: "authorized", taskStatus: "delivered", hasArtifact: true, reviewed: false, jobError: "" });
  assert.equal(sealed.headline, "The supervisor has not reviewed a delivery.");
  const workerChoice = hireProgress({
    paymentStatus: "authorized",
    taskStatus: "delivered",
    hasArtifact: true,
    reviewed: true,
    jobError: "",
    viewer: "worker",
  });
  assert.match(workerChoice.headline, /Waiting for the hirer/);
  assert.equal(workerChoice.stages.some((stage) => stage.label === "Hirer decision"), true);
  assert.equal(workerChoice.headline.includes("You choose"), false);
  assert.equal(scannerBlocksSeal({ allow: false, llama: "allow" }), true);
  assert.equal(scannerBlocksSeal({ allow: false, llama: "block" }), true);
  assert.equal(scannerBlocksSeal({ allow: true, llama: "unavailable" }), false);
  assert.equal(scannerBlocksSeal({ allow: false, llama: "unavailable" }), true);
  assert.equal(scannerBlocksSeal({ allow: true, llama: "allow" }), false);
  assert.equal(shouldStartWorker({ status: "authorized", artifactCid: null, jobError: "LlamaFirewall unavailable" }), true);
  assert.equal(taskPollWait({ status: "running" }), 3000);
  assert.equal(taskPollWait({ status: "delivered", hasArtifact: true, reviewed: false }), 3000);
  assert.equal(taskPollWait({ status: "delivered", hasArtifact: true, reviewed: true }), 10000);
  assert.equal(taskPollWait({ status: "settled", hasArtifact: true, reviewed: true }), null);
  assert.equal(taskPollWait({ status: "released" }), null);
});

test("overlapping desk saves keep both tasks", async () => {
  const holder = globalThis as { muselancerDesk?: Network };
  const previous = holder.muselancerDesk;
  holder.muselancerDesk = new Network();
  try {
    const first = `${"11".repeat(16)}`;
    const second = `${"22".repeat(16)}`;
    await Promise.all([
      withDesk(async (net) => {
        net.openTask({ id: first, buyerAgentId: "1", workerAgentId: "2", criteria: "First", amount: BigInt(1) });
        await new Promise((resolve) => setTimeout(resolve, 40));
      }),
      withDesk(async (net) => {
        net.openTask({ id: second, buyerAgentId: "1", workerAgentId: "2", criteria: "Second", amount: BigInt(1) });
      }),
    ]);
    const net = await desk();
    assert.equal(net.tasks.has(first), true);
    assert.equal(net.tasks.has(second), true);
  } finally {
    if (previous) {
      holder.muselancerDesk = previous;
      await saveDesk(previous);
    } else {
      holder.muselancerDesk = undefined;
      await deleteDocument("network");
    }
  }
});

test("a spent gateway budget does not follow the next hire", async () => {
  await saveTaskBudget("task-old", { remainingCalls: 0, remainingTokens: 0 });
  await openTaskBudget("task-new");
  assert.equal((await loadTaskBudget("task-old")).remainingCalls, 0);
  assert.equal((await loadTaskBudget("task-new")).remainingCalls, 20);
  await closeTaskBudget("task-new");
  assert.equal((await loadTaskBudget("task-new")).remainingCalls, 20);
});

test("readiness reports presence and hides secret values", () => {
  const modelKey = "sk-live-model-key-should-not-leak";
  const privySecret = "privy-secret-value";
  const supervisor = `0x${"11".repeat(32)}`;
  const ready = serverReadiness({
    NEXT_PUBLIC_PRIVY_APP_ID: "app",
    PRIVY_APP_SECRET: privySecret,
    BASE_RPC_URL: "https://sepolia.base.org",
    DIRECTORY_CLIENT_SERVER_ADDRESS: "example.ts.net:8888",
    NEXT_PUBLIC_APP_URL: "https://muselancer.example",
    MODEL_API_KEY: modelKey,
    SUPERVISOR_PRIVATE_KEY: supervisor,
  });
  assert.deepEqual(ready, {
    privy: true,
    baseRpc: true,
    directory: true,
    appUrl: true,
    modelKey: true,
  });
  const encoded = JSON.stringify(ready);
  assert.equal(encoded.includes(modelKey), false);
  assert.equal(encoded.includes(privySecret), false);
  assert.equal(encoded.includes(supervisor), false);
  assert.deepEqual(serverReadiness({}), {
    privy: false,
    baseRpc: false,
    directory: false,
    appUrl: true,
    modelKey: false,
  });
});

test("a hire quote is auth-capture on Base Sepolia and the exact proxy stays unused", () => {
  const { lock, receiver, operator } = sampleLock();
  const requirement = hireRequirement(lock);
  assert.equal(requirement.scheme, "auth-capture");
  assert.equal(requirement.network, "eip155:84532");
  assert.equal(requirement.asset, getAddress(USDC_BASE_SEPOLIA));
  assert.equal(requirement.amount, "5000000");
  assert.equal(requirement.payTo, receiver.address);
  assert.equal(requirement.receiver, receiver.address);
  assert.equal(requirement.extra.autoCapture, false);
  assert.equal(requirement.extra.escrow, getAddress(AUTH_CAPTURE_ESCROW));
  assert.equal(requirement.extra.tokenCollector, getAddress(ERC3009_COLLECTOR));
  assert.equal(requirement.extra.captureAuthorizer, operator.address);
  assert.equal(lock.preApprovalExpiry <= lock.authorizationExpiry && lock.authorizationExpiry <= lock.refundExpiry, true);
  const encoded = JSON.stringify(requirement).toLowerCase();
  assert.equal(encoded.includes(X402_EXACT_PERMIT2_PROXY.toLowerCase()), false);
  assert.equal(encoded.includes("\"exact\""), false);
  const file = JSON.parse(
    decodeDataJson(
      buildOnchainRegistration({
        name: "Writer",
        description: "Writes a one-page brief.",
        agentId: "7",
        oasfMessage: "{}",
      }).uri,
    ),
  ) as { x402Support: boolean };
  assert.equal(file.x402Support, true);
});

test("the ERC-3009 nonce ignores the payer and a signature must recover to the hirer", async () => {
  const { payer, lock } = sampleLock();
  assert.equal(PAYMENT_INFO_TYPEHASH, keccak256(toBytes(PAYMENT_INFO_TYPE)));
  const nonce = erc3009Nonce(lock);
  const otherPayer = privateKeyToAccount(generatePrivateKey()).address;
  assert.equal(erc3009Nonce({ ...lock, payer: otherPayer }), nonce);
  assert.notEqual(escrowPaymentHash(lock, lock.payer), nonce);
  const domain = fallbackUsdcDomain();
  const message = receiveMessage(lock);
  assert.equal(message.to, getAddress(ERC3009_COLLECTOR));
  assert.equal(message.value, lock.maxAmount);
  assert.equal(message.nonce, nonce);
  const typed = {
    domain,
    types: receiveWithAuthorizationTypes,
    primaryType: "ReceiveWithAuthorization" as const,
    message,
  };
  assert.equal(
    hashTypedData(typed),
    hashTypedData({
      ...typed,
      message: {
        from: message.from,
        to: message.to,
        value: BigInt(message.value),
        validAfter: BigInt(message.validAfter),
        validBefore: BigInt(message.validBefore),
        nonce: message.nonce,
      },
    }),
  );
  JSON.stringify(typed);
  const signature = await payer.signTypedData(typed);
  await assertHireSignature(domain, message, signature, payer.address);
  await assert.rejects(
    () => assertHireSignature(domain, message, signature, otherPayer),
    /Signature is not from the hirer/,
  );
});

test("policy refuses a paused agent, an unknown action, and a non-escrow recipient", () => {
  const request = {
    action: "hire",
    amountUsdc: "1000000",
    recipient: AUTH_CAPTURE_ESCROW,
    paused: false,
    spentTodayUsdc: "0",
    actionsLastMinute: 0,
  };
  assert.equal(evaluatePolicy(policy, { ...request, paused: true }).reason, "Agent is paused.");
  assert.equal(evaluatePolicy(policy, { ...request, action: "steal" }).reason, "Unknown action.");
  assert.equal(evaluatePolicy(policy, { ...request, amountUsdc: "6000000" }).allow, true);
  assert.equal(evaluatePolicy(policy, { ...request, spentTodayUsdc: "4500000" }).allow, true);
  assert.equal(evaluatePolicy(policy, { ...request, action: "pay", amountUsdc: "6000000" }).allow, true);
  assert.equal(evaluatePolicy(policy, { ...request, action: "pay", spentTodayUsdc: "4500000" }).allow, true);
  assert.equal(
    evaluatePolicy(policy, { ...request, recipient: privateKeyToAccount(generatePrivateKey()).address }).reason,
    "Recipient is not the escrow.",
  );
  assert.equal(evaluatePolicy(policy, request).allow, true);
});

test("a revision leaves the lock and a later pass captures it", () => {
  const net = new Network();
  const payer = freshAccount();
  const receiver = freshAccount();
  const task = net.openTask({
    id: "hire-1",
    buyerAgentId: payer.address,
    workerAgentId: "1",
    criteria: "Write the brief",
    amount: BigInt(5_000_000),
    longHorizon: false,
  });
  net.authorizePayment({
    id: "pay-1",
    payer: payer.address,
    receiver: receiver.address,
    amount: task.amount,
    taskId: task.id,
    expiry: Date.now() + 60_000,
  });
  net.markAuthorized(task.id, "pay-1");
  const revised = net.closeHire({ taskId: task.id, verdict: "needs_revision", now: Date.now() });
  assert.equal(revised.status, "revision");
  assert.equal(revised.longHorizon, false);
  assert.equal(net.getPayment("pay-1")?.status, "authorized");
  const passed = net.closeHire({ taskId: task.id, verdict: "pass", now: Date.now() });
  assert.equal(passed.status, "settled");
  assert.equal(net.getPayment("pay-1")?.status, "captured");

  const failed = net.openTask({
    id: "hire-2",
    buyerAgentId: payer.address,
    workerAgentId: "1",
    criteria: "Stop",
    amount: BigInt(1_000_000),
    longHorizon: true,
  });
  net.authorizePayment({
    id: "pay-2",
    payer: payer.address,
    receiver: receiver.address,
    amount: failed.amount,
    taskId: failed.id,
    expiry: Date.now() + 60_000,
  });
  net.markAuthorized(failed.id, "pay-2");
  const released = net.closeHire({ taskId: failed.id, verdict: "fail", now: Date.now() });
  assert.equal(released.status, "released");
  assert.equal(released.longHorizon, true);
  assert.equal(net.getPayment("pay-2")?.status, "voided");
});

test("a paused agent refuses the hire and a refresh keeps the saved price", () => {
  const net = new Network();
  const owner = freshAccount();
  const wallet = freshAccount();
  const agent = net.mintAgent({ owner: owner.address, agentWallet: wallet.address, agentUri: "", policy });
  agent.paused = true;
  const refused = net.decide(agent.agentId, {
    action: "hire",
    amountUsdc: "1000000",
    recipient: AUTH_CAPTURE_ESCROW,
    paused: false,
    spentTodayUsdc: "0",
    actionsLastMinute: 0,
  });
  assert.equal(refused.reason, "Agent is paused.");
  agent.paused = false;
  agent.policy = { ...agent.policy, perTaskCapUsdc: "2000000", dailyBudgetUsdc: "3000000" };
  agent.metadata = { ...agent.metadata, hirePriceUsdc: "1500000" };
  net.cacheAgent({
    agentId: agent.agentId,
    owner: owner.address,
    agentWallet: wallet.address,
    agentUri: "data:",
    name: "Writer",
    description: "Writes.",
    skillIds: "201",
    policy,
  });
  const kept = net.getAgent(agent.agentId);
  assert.equal(kept.policy.perTaskCapUsdc, "2000000");
  assert.equal(kept.policy.dailyBudgetUsdc, "3000000");
  assert.equal(kept.metadata.hirePriceUsdc, "1500000");
  assert.equal(kept.metadata.name, "Writer");
});

test("muse-wonder follows the long-horizon hire flag", () => {
  assert.doesNotThrow(() => assertModel("muse-spark-1.3", false));
  assert.equal(assertModel("muse-wonder", true), "muse-wonder-1.0");
  assert.equal(assertModel("muse-wonder", false), "muse-wonder-1.0");
  assert.equal(assertModel("muse-image-1.0", false), "muse-image-1.0");
  assert.throws(() => assertModel("not-a-model", false), /allowlist/);
});

test("an empty app URL defaults to localhost and the OASF name accepts it", () => {
  assert.equal(appOrigin({}), "http://localhost:3000");
  assert.equal(appOrigin({ NEXT_PUBLIC_APP_URL: "https://muselancer.example/" }), "https://muselancer.example");
  assert.equal(serverReadiness({ NEXT_PUBLIC_APP_URL: "" }).appUrl, true);
  assert.equal(serverReadiness({ NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000" }).appUrl, true);
  assert.equal(serverReadiness({ NEXT_PUBLIC_APP_URL: "http://example.com" }).appUrl, false);
  const record = buildOasfRecord({
    nameUrl: "http://localhost:3000/api/agents/7/oasf",
    description: "Writes a one-page brief.",
    skillIds: [201],
    agentId: "7",
    agentWallet: "0x0000000000000000000000000000000000000001",
    owner: "0x0000000000000000000000000000000000000002",
    oasfCid: "bafytest",
  });
  assert.equal(validateOasf(record), null);
  assert.equal(validateOasf({ ...record, name: "http://example.com/api/agents/7/oasf" }), "OASF name must use an https origin or localhost.");
  const owner = privateKeyToAccount(generatePrivateKey());
  const wallet = privateKeyToAccount(generatePrivateKey());
  const directory = buildDirectoryRecord({
    displayName: "Writer",
    description: "Writes a one-page brief.",
    skillIds: [201],
    taxonomy: new Map([[201, "images_computer_vision/image_segmentation"]]),
    agentId: "7",
    agentWallet: wallet.address,
    owner: owner.address,
    createdAt: "2026-10-28T21:00:00Z",
    origin: "http://127.0.0.1:3000",
  });
  assert.equal(directory.includes("http://127.0.0.1:3000/api/agents/7/oasf"), true);
  assert.throws(
    () =>
      buildDirectoryRecord({
        displayName: "Writer",
        description: "Writes a one-page brief.",
        skillIds: [201],
        taxonomy: new Map([[201, "images_computer_vision/image_segmentation"]]),
        agentId: "7",
        agentWallet: wallet.address,
        owner: owner.address,
        createdAt: "2026-10-28T21:00:00Z",
        origin: "http://example.com",
      }),
    /https origin or http:\/\/localhost:3000/,
  );
});

test("a buyer-operated hire quote asks the hirer to send authorize", () => {
  const payer = privateKeyToAccount(generatePrivateKey());
  const receiver = privateKeyToAccount(generatePrivateKey());
  const lock = buildHireLock({
    payer: payer.address,
    receiver: receiver.address,
    amount: "5000000",
    operator: payer.address,
    now: 1_700_000_000,
    salt: `0x${"22".repeat(32)}` as Hex,
  });
  assert.equal(lock.operator, payer.address);
  assert.equal(lock.feeReceiver, payer.address);
  assert.equal(hireRequirement(lock).extra.captureAuthorizer, payer.address);
  const signature = `0x${"ab".repeat(65)}` as Hex;
  const authorize = authorizeCall(lock, signature);
  assert.equal(authorize.to, getAddress(AUTH_CAPTURE_ESCROW));
  assert.equal(authorize.chainId, 84532);
  const decoded = decodeFunctionData({ abi: authCaptureAbi, data: authorize.data });
  assert.equal(decoded.functionName, "authorize");
  const info = decoded.args[0];
  const operator = typeof info === "object" && info !== null && "operator" in info ? String(info.operator) : "";
  assert.equal(getAddress(operator), payer.address);
  assert.equal(captureCall(lock).to, authorize.to);
  assert.equal(voidCall(lock).chainId, 84532);
  assert.equal(supervisorNote({ artifactCid: null, supervisorReport: null }), "The supervisor has not reviewed a delivery.");
  assert.equal(
    supervisorNote({ artifactCid: "bafy", supervisorReport: "It is HTML that appears to be a website or a landing page." }),
    "It is HTML that appears to be a website or a landing page.",
  );
  const delivery = "<!doctype html><title>Launch</title><p>Welcome to the product landing page for the new studio.</p>";
  assert.equal(acceptSupervisorReport("It is HTML that appears to be a website or a landing page.", delivery), "It is HTML that appears to be a website or a landing page.");
  assert.equal(acceptSupervisorReport(`The page says ${delivery}`, delivery), null);
  assert.equal(acceptSupervisorReport("The file contains a PRIVATE KEY for the site.", delivery), null);
  const hirer = "0x0000000000000000000000000000000000000001";
  const owner = "0x0000000000000000000000000000000000000002";
  const supervisorWallet = "0x0000000000000000000000000000000000000003";
  const workerWallet = "0x0000000000000000000000000000000000000004";
  assert.equal(isPlatformSupervisor({ agentId: "9", displayName: "Muselancer supervisor" }, "9"), true);
  assert.equal(supervisorSeat({ supervisorAgentId: "9", hiringAgentId: "3", workerAgentId: "4", supervisorOwner: owner, hirer }), "9");
  assert.throws(() => supervisorSeat({ supervisorAgentId: "3", hiringAgentId: "3", workerAgentId: "4", supervisorOwner: owner, hirer }), /different agent/);
  assert.throws(() => supervisorSeat({ supervisorAgentId: "4", hiringAgentId: "3", workerAgentId: "4", supervisorOwner: owner, hirer }), /different agent/);
  assert.throws(() => supervisorSeat({ supervisorAgentId: "9", hiringAgentId: "3", workerAgentId: "4", supervisorOwner: hirer, hirer }), /cannot belong to the hirer/);
  assert.equal(sealedToSupervisor([supervisorWallet], supervisorWallet, [hirer, workerWallet]), true);
  assert.equal(sealedToSupervisor([hirer], supervisorWallet, [hirer, workerWallet]), false);
  assert.equal(sealedToSupervisor([supervisorWallet, hirer], supervisorWallet, [hirer, workerWallet]), false);
  const guidance = supervisorGuidance([
    { path: "AGENTS.md", text: "Describe the kind of work and do not quote it." },
    { path: "USER.md", text: "OWNER-PRIVATE-NOTE" },
  ]);
  assert.match(guidance, /Describe the kind of work/);
  assert.equal(guidance.includes("OWNER-PRIVATE-NOTE"), false);
  const job = supervisorJobFiles("Muselancer supervisor").map((file) => file.text).join("\n");
  assert.match(job, /Role: supervisor/);
  assert.match(job, /not the hiring agent/);
  assert.match(job, /The hirer chooses/);
  assert.equal(acceptSupervisorSuggestion("confirm"), "confirm");
  assert.equal(acceptSupervisorSuggestion("revise"), "revise");
  assert.equal(acceptSupervisorSuggestion("reject"), "reject");
  assert.equal(acceptSupervisorSuggestion("pass"), null);
  assert.equal(supervisorSuggestionNote("revise"), "The supervisor suggests you send it back.");
  assert.equal(supervisorSuggestionNote("pass"), "");
  assert.equal(job.toLowerCase().includes("private key"), false);
  assert.equal(job.includes("USER.md"), false);
});

test("settlement waits for the verdict signer and returns the hirer calldata", async () => {
  const holder = globalThis as { muselancerDesk?: Network };
  const previousNet = holder.muselancerDesk;
  const previousKey = process.env.SUPERVISOR_PRIVATE_KEY;
  process.env.SUPERVISOR_PRIVATE_KEY = `0x${"11".repeat(32)}`;
  try {
    delete holder.muselancerDesk;
    const net = await desk();
    const payer = freshAccount();
    const receiver = freshAccount();
    const lock = buildHireLock({
      payer: payer.address,
      receiver: receiver.address,
      amount: "1000000",
      operator: payer.address,
      now: Math.floor(Date.now() / 1000),
      salt: `0x${"33".repeat(32)}` as Hex,
    });
    const waiting = net.openTask({
      id: "aa".repeat(16),
      buyerAgentId: payer.address,
      workerAgentId: "1",
      criteria: "Write the brief",
      amount: BigInt(1_000_000),
      lock,
    });
    net.authorizePayment({
      id: "pay-wait",
      payer: payer.address,
      receiver: receiver.address,
      amount: waiting.amount,
      taskId: waiting.id,
      expiry: Date.now() + 60_000,
    });
    net.markAuthorized(waiting.id, "pay-wait");
    await saveDesk(net);
    await assert.rejects(
      () => settlementCall({ payer: payer.address, taskId: waiting.id, verdict: "pass" }),
      /The supervisor has not reviewed a delivery/,
    );

    const artifact = "bafyreviewed";
    waiting.artifactCid = artifact;
    waiting.supervisorReport = "It is HTML that appears to be a website or a landing page.";
    await saveDesk(net);
    const declined = await settlementCall({ payer: payer.address, taskId: waiting.id, verdict: "fail" });
    assert.equal("void" in declined && declined.void?.to, getAddress(AUTH_CAPTURE_ESCROW));
    assert.equal(net.getPayment("pay-wait")?.status, "authorized");
    const previousModel = process.env.MODEL_API_KEY;
    process.env.MODEL_API_KEY = "test-model-key";
    try {
      const chosen = await settlementCall({ payer: payer.address, taskId: waiting.id, verdict: "pass" });
      assert.equal("capture" in chosen && chosen.capture?.chainId, 84532);
    } finally {
      if (previousModel === undefined) delete process.env.MODEL_API_KEY;
      else process.env.MODEL_API_KEY = previousModel;
    }
    assert.equal(waiting.verdict, null);
    assert.equal(net.getPayment("pay-wait")?.status, "authorized");

    const revision = net.openTask({
      id: "bb".repeat(16),
      buyerAgentId: payer.address,
      workerAgentId: "1",
      criteria: "Revise the brief",
      amount: BigInt(1_000_000),
      lock: { ...lock, salt: `0x${"44".repeat(32)}` as Hex },
    });
    revision.artifactCid = artifact;
    revision.supervisorReport = "It is HTML that appears to be a website or a landing page.";
    net.authorizePayment({
      id: "pay-revise",
      payer: payer.address,
      receiver: receiver.address,
      amount: revision.amount,
      taskId: revision.id,
      expiry: Date.now() + 60_000,
    });
    net.markAuthorized(revision.id, "pay-revise");
    await saveDesk(net);
    const sentBack = await settlementCall({ payer: payer.address, taskId: revision.id, verdict: "needs_revision" });
    assert.equal("status" in sentBack && sentBack.status, "revision");
    assert.equal("capture" in sentBack, false);
    assert.equal(net.getPayment("pay-revise")?.status, "authorized");

    delete holder.muselancerDesk;
    process.env.SUPERVISOR_PRIVATE_KEY = `0x${"11".repeat(32)}`;
    const opened = await desk();
    assert.equal(opened.snapshot().supervisorKey, undefined);
    const stored = await readDocument("network");
    if (stored) assert.equal(stored.includes(`0x${"11".repeat(32)}`), false);
  } finally {
    if (previousKey === undefined) delete process.env.SUPERVISOR_PRIVATE_KEY;
    else process.env.SUPERVISOR_PRIVATE_KEY = previousKey;
    holder.muselancerDesk = previousNet;
  }
});

test("a suggestion must come from the search and a price above the limits is refused", () => {
  const hits = [
    { agentId: "4", name: "Ada" },
    { agentId: "9", name: "Bea" },
  ];
  assert.throws(() => assertListedSuggestion("3", hits), /not in the search/);
  assert.equal(nextSuggestion(hits, ["4"], "9"), null);
  assert.equal(nextSuggestion(hits, ["4"], "1")?.agentId, "9");
  assert.equal(nextSuggestion([], [], "1"), null);
  const overBudget = assessPrice({ price: "2000000", budget: "1000000" });
  assert.equal(overBudget.ok, false);
  assert.equal(overBudget.reason, "The price is above your budget.");
  const insideOwnerBudget = assessPrice({ price: "6000000", budget: "9000000" });
  assert.equal(insideOwnerBudget.ok, true);
  const spentDayStillOk = assessPrice({ price: "2000000", budget: "9000000" });
  assert.equal(spentDayStillOk.ok, true);
  assert.equal(counterLoosens({ price: "3000000", budget: "2000000", deadlineMs: 10, humanDeadlineMs: 10 }), true);
  assert.equal(counterLoosens({ price: "2000000", budget: "2000000", deadlineMs: 20, humanDeadlineMs: 10 }), true);
  assert.equal(roomForRound(2), true);
  assert.equal(roomForRound(3), false);
  assert.equal(roomForRound(4), false);
});

test("a negotiation round sees this deal's thread and not another deal", () => {
  const shared = {
    brief: "Review the API.",
    constraints: "Stay inside the posted price.",
    budgetLabel: "8",
    deadline: "2026-11-08T00:00:00.000Z",
    postedPrice: "5",
    perTaskCap: "10",
  };
  const continued = negotiationInstruction({
    ...shared,
    turns: [
      { role: "human", text: "Review the API." },
      { role: "agent", text: "I offered 5 USDC, deliver by 2026-11-02T00:00:00.000Z." },
      { role: "agent", text: "The other agent asks for 8 USDC. EARLIER-COUNTER." },
      { role: "agent", text: "I offered 8 USDC, deliver by 2026-11-08T00:00:00.000Z." },
    ],
    offers: [
      { side: "buyer", action: "offer", priceLabel: "5", deadline: "2026-11-02T00:00:00.000Z", reason: "First offer." },
      { side: "worker", action: "counter", priceLabel: "8", deadline: "2026-11-08T00:00:00.000Z", reason: "EARLIER-COUNTER." },
      { side: "buyer", action: "offer", priceLabel: "8", deadline: "2026-11-08T00:00:00.000Z", reason: "Matched the counter." },
    ],
  });
  assert.match(continued, /EARLIER-COUNTER/);
  assert.match(continued, /I offered 8 USDC/);
  assert.match(continued, /Buyer budget: 8 USDC/);
  assert.match(continued, /action is accept and price is that offer/);
  assert.match(continued, /Do not wait for another message/);
  const fresh = negotiationInstruction({
    ...shared,
    brief: "Write the docs.",
    turns: [{ role: "human", text: "Write the docs." }],
    offers: [{ side: "buyer", action: "offer", priceLabel: "8", deadline: "2026-11-08T00:00:00.000Z", reason: "NEW-DEAL-OFFER." }],
  });
  assert.match(fresh, /NEW-DEAL-OFFER/);
  assert.equal(fresh.includes("EARLIER-COUNTER"), false);
  assert.equal(fresh.includes("Review the API."), false);
});

test("follow-up questions stay with the owner and a new deal stays separate", () => {
  assert.equal(clarifyGate({ action: "ask", question: "Which language?", asked: 0 }), "ask");
  assert.equal(clarifyGate({ action: "ask", question: "Which language?", asked: 3 }), "ask");
  assert.equal(clarifyGate({ action: "ask", question: "Which language?", asked: 8 }), "search");
  assert.equal(clarifyGate({ action: "search", question: "Which language?", asked: 0 }), "search");
  assert.equal(scopeGate({ action: "ask", question: "Which pages?", asked: 2 }), "ask");
  assert.equal(scopeGate({ action: "ready", question: "", asked: 0 }), "ready");
  assert.deepEqual(relayDecision({ action: "answer", answer: "A marketing site in TypeScript." }), { kind: "answer", text: "A marketing site in TypeScript." });
  assert.deepEqual(relayDecision({ action: "ask_owner", answer: "" }), { kind: "ask_owner" });
  assert.deepEqual(relayDecision({ action: "answer", answer: "  " }), { kind: "ask_owner" });
  const work = dealWorkText({
    brief: "Build a website.",
    clarifications: ["A marketing site in TypeScript."],
    constraints: "No payments.",
    deadline: "2026-11-08T00:00:00.000Z",
  });
  assert.match(work, /A marketing site in TypeScript/);
  assert.match(work, /No payments/);
  const scoped = scopeInstruction({
    brief: "Build a website.",
    constraints: "",
    clarifications: ["A marketing site in TypeScript."],
    turns: [{ role: "human", text: "Build a website." }],
  });
  assert.match(scoped, /A marketing site in TypeScript/);
  assert.match(scoped, /Do not name a price yet/);
  assert.match(scoped, /any kind of work/);
  assert.match(scoped, /still missing/);
  assert.equal(scoped.includes("enough to negotiate a price"), false);
  const judged = briefJudgmentInstruction({
    brief: "Prepare the quarterly report.",
    clarifications: [],
    turns: [{ role: "human", text: "Prepare the quarterly report." }],
  });
  assert.match(judged, /any kind of work/);
  assert.match(judged, /you look again/);
  assert.match(judged, /in your own words/);
  assert.match(judged, /no prepared question/);
  assert.match(judged, /Do not treat one kind of task differently/);
  assert.equal(judged.includes("landing page"), false);
  const other = negotiationInstruction({
    brief: "Write the docs.",
    constraints: "",
    budgetLabel: "8",
    deadline: "2026-11-08T00:00:00.000Z",
    postedPrice: "5",
    perTaskCap: "10",
    clarifications: ["OTHER-DEAL-FACT"],
    turns: [],
    offers: [],
  });
  assert.match(other, /OTHER-DEAL-FACT/);
  assert.equal(scoped.includes("OTHER-DEAL-FACT"), false);
});

test("the hire quote uses the agreed amount only after confirm", () => {
  assert.throws(() => agreedLockAmount({ stage: "negotiate", agreedPriceUsdc: "1500000", postedPriceUsdc: "5000000" }), /Confirm the deal before the hire quote/);
  assert.throws(() => agreedLockAmount({ stage: "terms", agreedPriceUsdc: null, postedPriceUsdc: "5000000" }), /Confirm the deal before the hire quote/);
  assert.equal(agreedLockAmount({ stage: "confirm", agreedPriceUsdc: "1500000", postedPriceUsdc: "5000000" }), "1500000");
  const now = Date.parse("2026-10-30T00:00:00.000Z");
  assert.equal(reviewDeadline(now + 8 * 24 * 60 * 60 * 1000, now), "beyond-lock");
  assert.equal(reviewDeadline(now + 6 * 24 * 60 * 60 * 1000, now), "ok");
  assert.deepEqual(skillIdsFromModel(JSON.stringify({ skillIds: [201, 999999, 1.5, "4"] }), new Set([201, 4])), [201]);
});

test("a hire matches worker capabilities and a missing model is refused", async () => {
  assert.equal(conversationModel("muse-voice-transcribe-1.0"), "muse-spark-1.3");
  assert.equal(conversationModel("muse-image-1.0"), "muse-spark-1.3");
  assert.equal(conversationModel("sam-3.1"), "muse-spark-1.3");
  assert.equal(conversationModel("muse-wonder-1.0"), "muse-wonder-1.0");
  assert.equal(conversationModel("muse-spark-1.3-contributor"), "muse-spark-1.3-contributor");
  assert.equal(performsTasks("muse-spark-1.3"), true);
  assert.equal(performsTasks("muse-wonder-1.0"), true);
  assert.equal(performsTasks("muse-spark-1.3-contributor"), true);
  assert.equal(performsTasks("muse-voice-transcribe-1.0"), false);
  assert.equal(performsTasks("muse-image-1.0"), false);
  assert.equal(performsTasks("sam-3.1"), false);
  assert.equal(taskRefusal("muse-voice-transcribe-1.0"), "This agent does not do that task. The text model does not do the work.");
  assert.equal(taskRefusal("muse-spark-1.3"), null);
  assert.equal(leavesCurrentDeal("you should be the one who create another landing page"), true);
  assert.equal(leavesCurrentDeal("ignore the deal , this is between me and you , create a new page with javascript , not with worker"), true);
  assert.equal(leavesCurrentDeal("after we confirm the deal the supervisor will be deployed"), false);
  const now = Date.parse("2026-11-03T00:00:00.000Z");
  const scratch = "let's try from the scratch , findlet's hire for an agent to create an html + css landing page";
  assert.equal(wantsFreshHire(scratch), true);
  assert.equal(cancelOnlyHire(scratch), false);
  assert.equal(wantsFreshHire("Cancel this hire."), true);
  assert.equal(cancelOnlyHire("Cancel this hire."), true);
  assert.equal(wantsFreshHire("keep going with the hiring process"), false);
  assert.equal(wantsFreshHire("after we confirm the deal the supervisor will be deployed"), false);
  const replaced = decideHireContinuation({
    stage: "confirm",
    pendingAsk: false,
    pendingCounter: false,
    currentAgentId: "10531",
    statedBudget: "5",
    statedConstraints: "",
    message: scratch,
    earlierOwnerText: "",
    now,
  });
  assert.equal(replaced?.kind, "replace");
  const lockedFresh = decideHireContinuation({
    stage: "locked",
    pendingAsk: false,
    pendingCounter: false,
    currentAgentId: "10531",
    statedBudget: "5",
    statedConstraints: "",
    message: scratch,
    earlierOwnerText: "",
    now,
  });
  assert.equal(lockedFresh, null);
  const paid = hireStatusReport({
    role: "hirer",
    workerName: "Muse dev agent",
    workerAgentId: "10531",
    paymentStatus: "captured",
    taskStatus: "settled",
    hasArtifact: true,
    reviewed: true,
    deliveryReleased: true,
    jobError: "",
  });
  assert.match(paid, /Your part: hiring agent/);
  assert.match(paid, /Payment: captured/);
  assert.match(paid, /Files released: yes/);
  assert.match(paid, /Worker in the sandbox: no/);
  assert.match(paid, /Task status: settled/);
  const working = hireStatusReport({
    role: "worker",
    workerName: "Muse dev agent",
    workerAgentId: "10531",
    paymentStatus: "authorized",
    taskStatus: "running",
    hasArtifact: false,
    reviewed: false,
    deliveryReleased: false,
    jobError: "",
  });
  assert.match(working, /Your part: hired agent/);
  assert.match(working, /Payment: authorized/);
  assert.match(working, /Worker in the sandbox: yes/);
  const chosen = preferHireState(
    { status: "authorized" },
    "authorized",
    { status: "settled" },
    "captured",
  );
  assert.equal(chosen.task?.status, "settled");
  assert.equal(chosen.paymentStatus, "captured");
  assert.equal(assertModel(conversationModel(""), true), "muse-spark-1.3");
  assert.equal(assertModel(conversationModel(undefined as unknown as string), true), "muse-spark-1.3");
  await assert.rejects(
    () => sparkStructured({ model: undefined as unknown as string, name: "skills", instruction: "job", schema: { type: "object" } }),
    /Choose a model/,
  );
  const coding = [
    { id: 502, name: "analytical_skills/coding_skills", caption: "Coding Skills", description: "Capabilities for code generation, documentation, and optimization." },
    { id: 50201, name: "analytical_skills/coding_skills/text_to_code", caption: "Text to Code", description: "Translating natural language instructions into executable code." },
    { id: 70202, name: "multi_modal/audio_processing/speech_recognition", caption: "Automatic Speech Recognition", description: "Speech to text." },
  ];
  const names = new Map(coding.map((skill) => [skill.id, skill.name]));
  assert.equal(skillCoverRank(502, 50201, names), 2);
  assert.equal(skillCoverRank(50201, 50201, names), 3);
  assert.equal(skillCoverRank(70202, 50201, names), 0);
  const roster = capabilityRosterLines([
    { agentId: "10531", name: "Muse dev agent", description: "This is a senior dev Muse agent", skillIds: [502] },
    { agentId: "10536", name: "Muse voice transcribe", description: "Transcribes speech.", skillIds: [70202] },
  ], coding);
  const instruction = capabilitySkillInstruction("Create an HTML landing page for Muse voice transcribe services.", roster);
  assert.match(instruction, /Do not look for a skill whose name repeats the request/);
  assert.match(instruction, /The subject of the deliverable is not a skill/);
  assert.match(instruction, /HTML landing page/);
  assert.match(instruction, /Muse dev agent/);
  assert.match(instruction, /502 Coding Skills \(published\)/);
  assert.match(instruction, /50201 Text to Code \(covered by a published skill\)/);
  assert.equal(instruction.includes("search phrase"), false);
  const ranked = rankByCapabilities([
    { agentId: "1", name: "Phrase match", skillIds: [3] },
    { agentId: "2", name: "Builder", skillIds: [10201, 50101] },
    { agentId: "3", name: "Writer", skillIds: [10201] },
  ], [10201, 50101]);
  assert.deepEqual(ranked.map((item) => item.agentId), ["2", "3", "1"]);
  const covered = rankByCapabilityCoverage([
    { agentId: "10536", name: "Muse voice transcribe", skillIds: [70202] },
    { agentId: "10531", name: "Muse dev agent", skillIds: [502] },
    { agentId: "9", name: "Exact coder", skillIds: [50201] },
  ], [50201], coding);
  assert.deepEqual(covered.map((item) => item.agentId), ["9", "10531"]);
  assert.deepEqual(coverageReasons([502], ["Coding Skills"], [50201], coding), ["Coding Skills (covers Text to Code)"]);
  const landing = "Create an HTML landing page for a studio.";
  assert.ok(descriptionFit(landing, "This is a senior dev Muse agent that builds HTML pages.") > descriptionFit(landing, "Transcribes speech to text."));
  const described = rankBySkillAndDescription([
    { agentId: "1", name: "Voice", description: "Transcribes speech to text.", skillIds: [502] },
    { agentId: "2", name: "Builder", description: "Builds HTML landing pages for studios.", skillIds: [502] },
  ], [502], coding, landing);
  assert.deepEqual(described.map((item) => item.agentId), ["2", "1"]);
  const choice = bestWorkerInstruction(landing, ["Builder\nSkills Coding Skills\nBuilds HTML landing pages."]);
  assert.match(choice, /published skills and the agent's description/);
  assert.match(choice, /Builds HTML landing pages/);
  const raw = JSON.stringify({ agentId: "2", reason: "Coding Skills and a description of HTML landing pages" });
  assert.equal(chosenWorkerId(raw, new Set(["2", "1"])), "2");
  assert.equal(chosenWorkerId(raw, new Set(["1"])), null);
  assert.equal(workerReason(raw), "Coding Skills and a description of HTML landing pages");
  assert.deepEqual(promoteChosenWorker(described, "1").map((item) => item.agentId), ["1", "2"]);
});

test("a memory proposal stays out of memory until the owner confirms", async () => {
  const owner = privateKeyToAccount(generatePrivateKey());
  const other = privateKeyToAccount(generatePrivateKey());
  assert.throws(() => assertProfileOwner(owner.address, other.address), /owner of this agent/);
  const profile = saveCharacter(blankProfile("9", owner.address), {
    displayName: "Desk name",
    personality: "SECRET-PERSONALITY-PHRASE",
    style: "warm",
    objectives: "help the owner",
    instructions: "ask before spending",
  });
  let memory = "Registered Ada.";
  const proposed = withProposal(profile, "Likes blue notebooks.", "p1");
  assert.equal(memory.includes("blue notebooks"), false);
  assert.equal(memory.includes(profile.voice.personality), false);
  assert.equal(proposed.proposals.length, 1);
  const task = workerTaskText("Paint the door.");
  assert.equal(task, "Paint the door.");
  assert.equal(task.includes(profile.voice.personality), false);
  assert.equal(task.includes(proposed.proposals[0].fact), false);
  assert.equal(task.includes(profile.conduct.instructions.join("\n")), false);
  memory = appendConfirmedFact(memory, proposed.proposals[0].fact);
  assert.match(memory, /Likes blue notebooks/);
  assert.equal(memory.includes(profile.voice.personality), false);

  const net = new Network(generatePrivateKey());
  const agent = net.mintAgent({
    owner: owner.address,
    agentWallet: other.address,
    agentUri: "data:",
    policy: defaultPolicy(),
  });
  await writeMemoryHead(net, {
    agentId: agent.agentId,
    owner: owner.address,
    memoryKey: memoryKey(),
    plaintext: "Registered Ada.",
    password: "owner-phrase",
  });
  assert.equal(await net.readMemory({ agentId: agent.agentId, owner: owner.address, password: "owner-phrase" }), "Registered Ada.");
  await writeMemoryHead(net, {
    agentId: agent.agentId,
    owner: owner.address,
    memoryKey: memoryKey(),
    plaintext: appendConfirmedFact("Registered Ada.", proposed.proposals[0].fact),
    password: "owner-phrase",
  });
  const opened = await net.readMemory({ agentId: agent.agentId, owner: owner.address, password: "owner-phrase" });
  assert.match(opened, /Likes blue notebooks/);
  assert.equal(opened.includes(profile.voice.personality), false);
});

test("the sealed owner chat does not take the private profile", async () => {
  const owner = await createMailboxKey();
  const phrase = "SECRET-PERSONALITY-PHRASE";
  const agentId = "teach-chat";
  const envelope = await sealTo({
    id: "teach-1",
    from: "owner",
    to: "agent",
    senderPrivate: owner.privateKey,
    recipientSpki: await agentPublicSpki(agentId),
    plaintext: `Personality: ${phrase}. Remember that I like blue.`,
  });
  const thread = await acceptOwnerEnvelope({ agentId, envelope, ownerSpki: owner.publicSpki });
  assert.equal(thread.some((item) => item.from === "agent"), false);
  const stored = await readDocument(`mailbox:${agentId}`);
  assert.equal(stored?.includes(phrase), false);
});

test("an owner answer continues the hire without another prompt", () => {
  const now = Date.parse("2026-11-01T23:00:00.000Z");
  const soon = ownerDeadlineMs("as soon as possible", now);
  assert.equal(soon, now + 24 * 60 * 60 * 1000);
  assert.equal(reviewDeadline(soon ?? 0, now), "ok");
  const day = ownerDeadlineMs("2026-11-05", now);
  assert.equal(day, Date.parse("2026-11-05T23:59:59.000Z"));
  assert.equal(reviewDeadline(day ?? 0, now), "ok");
  const accepted = decideHireContinuation({
    stage: "suggest",
    pendingAsk: false,
    pendingCounter: false,
    currentAgentId: "10531",
    statedBudget: null,
    statedConstraints: "",
    message: "accept",
    earlierOwnerText: "",
    now,
  });
  assert.deepEqual(accepted, { kind: "accept", agentId: "10531" });
  const first = decideHireContinuation({
    stage: "terms",
    pendingAsk: false,
    pendingCounter: false,
    currentAgentId: "10531",
    statedBudget: null,
    statedConstraints: "",
    message: "my budget is 10 USDC , i need it to be delivered as soon as possible , he needs to be creative about the landing page",
    earlierOwnerText: "accept",
    now,
  });
  assert.equal(first?.kind, "terms");
  if (first?.kind !== "terms") return;
  assert.equal(first.budget, "10");
  assert.equal(first.deadline, new Date(now + 24 * 60 * 60 * 1000).toISOString());
  assert.match(first.constraints, /creative about the landing page/);
  const earlier = [
    "search for a specialized agent that can code",
    "accept",
    "my budget is 10 USDC , i need it to be delivered as soon as possible , he needs to be creative about the landing page",
    "2026-11-05",
    "start",
  ].join("\n");
  const continued = decideHireContinuation({
    stage: "terms",
    pendingAsk: false,
    pendingCounter: false,
    currentAgentId: "10531",
    statedBudget: null,
    statedConstraints: "",
    message: "continue",
    earlierOwnerText: earlier,
    now,
  });
  assert.equal(continued?.kind, "terms");
  if (continued?.kind !== "terms") return;
  assert.equal(continued.budget, "10");
  assert.equal(continued.deadline, "2026-11-05T23:59:59.000Z");
  assert.match(continued.constraints, /creative about the landing page/);
  assert.equal(continued.constraints.includes("10 USDC"), false);
  assert.equal(usableWorkQuestion("Could you please complete the cut-off message starting with 'yes the work is...'?"), false);
  assert.equal(usableWorkQuestion("Which sections should the page include?"), true);
  assert.equal(parseOfferAmount("5 USDC"), "5000000");
  const offerDeadline = Date.parse("2026-11-04T23:59:59.000Z");
  assert.equal(workerAcceptsOffer({
    action: "accept",
    price: "5000000",
    offerPrice: "5000000",
    budget: "10000000",
    deadlineMs: offerDeadline,
    offerDeadlineMs: offerDeadline,
  }), true);
  assert.equal(workerAcceptsOffer({
    action: "accept",
    price: "10000000",
    offerPrice: "5000000",
    budget: "10000000",
    deadlineMs: offerDeadline,
    offerDeadlineMs: offerDeadline,
  }), false);
  const resumed = decideHireContinuation({
    stage: "stopped",
    pendingAsk: false,
    pendingCounter: false,
    currentAgentId: "10531",
    statedBudget: "10",
    statedConstraints: "be creative",
    message: "keep going with the hiring process",
    earlierOwnerText: "",
    now,
  });
  assert.equal(resumed?.kind, "resume");
  const held = decideHireContinuation({
    stage: "suggest",
    pendingAsk: false,
    pendingCounter: false,
    currentAgentId: "10531",
    statedBudget: null,
    statedConstraints: "",
    message: "keep going with the hiring process",
    earlierOwnerText: "",
    now,
  });
  assert.equal(held?.kind, "hold");
  const answered = decideHireContinuation({
    stage: "terms",
    pendingAsk: true,
    pendingCounter: false,
    currentAgentId: "10531",
    statedBudget: "10",
    statedConstraints: "",
    message: "yes the work is a HTML landing page for Muse voice transcribe services, be creative, no demo needed",
    earlierOwnerText: "my budget is 10 USDC",
    now,
  });
  assert.equal(answered?.kind, "answer");
  const confirmed = decideHireContinuation({
    stage: "confirm",
    pendingAsk: false,
    pendingCounter: false,
    currentAgentId: "10531",
    statedBudget: "10",
    statedConstraints: "",
    message: "after we confirm the deal the supervisor will be deployed",
    earlierOwnerText: "my budget is 10 USDC\n2026-11-04",
    now,
  });
  assert.equal(confirmed?.kind, "hold");
  if (confirmed?.kind === "hold") assert.match(confirmed.say, /Press Confirm and lock USDC/);
  const ownWork = decideHireContinuation({
    stage: "confirm",
    pendingAsk: false,
    pendingCounter: false,
    currentAgentId: "10531",
    statedBudget: "10",
    statedConstraints: "",
    message: "no , i want YOU as Muse voice transcribe to create a new landing page with javascript",
    earlierOwnerText: "",
    now,
  });
  assert.equal(ownWork, null);
  const lockedTalk = decideHireContinuation({
    stage: "locked",
    pendingAsk: false,
    pendingCounter: false,
    currentAgentId: "10531",
    statedBudget: "10",
    statedConstraints: "",
    message: "create a landing page with HTML and css",
    earlierOwnerText: "",
    now,
  });
  assert.equal(lockedTalk, null);
  assert.equal(statedDeadline("yes 5 usdc delivery day 2026-11-03", "2026-11-04T23:59:59.000Z", now), "2026-11-03T23:59:59.000Z");
  const lock = ownerControls({
    stage: "confirm",
    pendingAsk: null,
    pendingCounter: null,
    current: null,
    selectedAgentId: "10531",
    budgetLabel: "10",
    deadline: "2026-11-04T23:59:59.000Z",
    needsWindow: false,
  });
  assert.equal(lock?.lock, true);
  assert.equal(lock?.form, false);
  assert.equal(lock?.choices.some((choice) => choice.label === "Cancel this hire"), true);
  const budgetPrompt = ownerControls({
    stage: "terms",
    pendingAsk: null,
    pendingCounter: null,
    current: null,
    selectedAgentId: "10531",
    budgetLabel: null,
    deadline: null,
    needsWindow: false,
  });
  assert.equal(budgetPrompt?.form, true);
  const continuePrompt = ownerControls({
    stage: "negotiate",
    pendingAsk: null,
    pendingCounter: null,
    current: null,
    selectedAgentId: "10531",
    budgetLabel: "10",
    deadline: "2026-11-04T23:59:59.000Z",
    needsWindow: false,
  });
  assert.equal(continuePrompt?.form, false);
  assert.equal(continuePrompt?.choices[0]?.label, "Continue");
  assert.notEqual(controlIdentity({
    stage: "suggest",
    pendingAsk: null,
    pendingCounter: null,
    current: { name: "Muse dev agent" },
    selectedAgentId: null,
    budgetLabel: null,
    deadline: null,
    needsWindow: false,
  }), controlIdentity({
    stage: "confirm",
    pendingAsk: null,
    pendingCounter: null,
    current: null,
    selectedAgentId: "10531",
    budgetLabel: "10",
    deadline: "2026-11-04T23:59:59.000Z",
    needsWindow: false,
  }));
  const negotiating = decideHireContinuation({
    stage: "negotiate",
    pendingAsk: false,
    pendingCounter: false,
    currentAgentId: "10531",
    statedBudget: "10",
    statedConstraints: "",
    message: "after we confirm the deal the supervisor will be deployed",
    earlierOwnerText: "my budget is 10 USDC\n2026-11-04",
    now,
  });
  assert.equal(negotiating?.kind, "status");
  const stopped = decideHireContinuation({
    stage: "stopped",
    pendingAsk: false,
    pendingCounter: false,
    currentAgentId: "10531",
    statedBudget: "10",
    statedConstraints: "",
    message: "after we confirm the deal the supervisor will be deployed",
    earlierOwnerText: "my budget is 10 USDC\n2026-11-04",
    now,
  });
  assert.equal(stopped?.kind, "resume");
  const offered = offerInsideLimits({
    budget: "10000000",
    posted: "5000000",
  });
  assert.equal(offered.ok, true);
  if (offered.ok) assert.equal(offered.price, "5000000");
  const exhaustedDay = offerInsideLimits({ budget: "5000000", posted: "5000000" });
  assert.equal(exhaustedDay.ok, true);
  if (exhaustedDay.ok) {
    assert.equal(exhaustedDay.price, "5000000");
    assert.equal(exhaustedDay.limitedBy, "posted");
  }
  const underPosted = offerInsideLimits({ budget: "3000000", posted: "5000000" });
  assert.equal(underPosted.ok, true);
  if (underPosted.ok) {
    assert.equal(underPosted.price, "3000000");
    assert.equal(underPosted.limitedBy, "budget");
  }
});

test("the hire prompt keeps the task and leaves owner notes out", () => {
  const skills = referenceSkillFiles([
    { files: [{ path: "SKILL.md", text: "Use a short page.", hash: "1" }, { path: "USER.md", text: "OWNER-PRIVATE-NOTE", hash: "2" }] },
  ]);
  assert.equal(skills.some((file) => file.path === "USER.md"), false);
  const prompt = jobPrompt({ criteria: "Paint the door.", skills, files: [], lastOutput: "", revision: false });
  assert.match(prompt, /Paint the door/);
  assert.match(prompt, /Muselancer agent hired for this task/);
  assert.match(prompt, /Do not wait for another message/);
  assert.match(prompt, /Use a short page/);
  assert.equal(prompt.includes("OWNER-PRIVATE-NOTE"), false);
  assert.equal(prompt.includes("USER.md"), false);
});

test("a hire job stops after six sandbox turns", async () => {
  let calls = 0;
  const files = await runJobTurns({
    criteria: "Paint the door.",
    longHorizon: false,
    skills: [],
    initial: [],
    revision: false,
    callModel: async () => {
      calls += 1;
      return { files: [{ path: "a.txt", text: "x" }], command: [], done: false };
    },
    runSandbox: async (job) => ({ ok: true, stdout: "", files: job.writes }),
  });
  assert.equal(calls, JOB_TURN_CAP);
  assert.equal(files[0]?.text, "x");
  let ranCommand = true;
  const kept = await runJobTurns({
    criteria: "Paint the door.",
    longHorizon: false,
    skills: [],
    initial: [],
    revision: false,
    callModel: async () => ({ files: [{ path: "index.html", text: "<p>Hello</p>" }], command: ["python\n-c"], done: true }),
    runSandbox: async (job) => {
      ranCommand = job.command.length > 0;
      return { ok: true, stdout: "", files: job.writes };
    },
  });
  assert.equal(ranCommand, false);
  assert.equal(kept[0]?.path, "index.html");
});

test("the job sandbox returns the tree and refuses a path outside it", () => {
  const python = process.env.PYTHON ?? "python";
  const ran = spawnSync(python, ["runtime/job_sandbox.py"], {
    input: JSON.stringify({
      files: [{ path: "index.html", text: "<p>Hello</p>" }],
      writes: [{ path: "notes.txt", text: "draft" }],
      command: ["python", "-c", "open('built.txt','w',encoding='utf-8').write('built')"],
    }),
    encoding: "utf8",
    cwd: process.cwd(),
  });
  assert.equal(ran.status, 0, ran.stderr);
  const body = JSON.parse(ran.stdout || "{}") as { ok: boolean; files: { path: string; text: string }[] };
  assert.equal(body.ok, true);
  assert.equal(body.files.find((file) => file.path === "built.txt")?.text, "built");
  assert.equal(body.files.find((file) => file.path === "index.html")?.text, "<p>Hello</p>");
  const escaped = spawnSync(python, ["runtime/job_sandbox.py"], {
    input: JSON.stringify({ files: [], writes: [{ path: "../outside.txt", text: "no" }], command: [] }),
    encoding: "utf8",
    cwd: process.cwd(),
  });
  const refused = JSON.parse(escaped.stdout || "{}") as { ok: boolean; error?: string };
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? "", /outside the sandbox/);
});

test("a hire job seals the sandbox and confirm releases the files", async () => {
  const holder = globalThis as { muselancerDesk?: Network };
  const previousNet = holder.muselancerDesk;
  const previousDoc = await readDocument("network");
  const previousSecret = process.env.MUSELANCER_SECRET;
  process.env.MUSELANCER_SECRET = "test-secret-not-used-in-production";
  try {
    delete holder.muselancerDesk;
    const net = await desk();
    const payer = freshAccount();
    const worker = freshAccount();
    const supervisor = freshAccount();
    const workerOwner = freshAccount();
    const lock = buildHireLock({
      payer: payer.address,
      receiver: worker.address,
      amount: "1000000",
      operator: payer.address,
      now: Math.floor(Date.now() / 1000),
      salt: `0x${"55".repeat(32)}` as Hex,
    });
    const task = net.openTask({
      id: "cc".repeat(16),
      buyerAgentId: payer.address,
      workerAgentId: "41",
      criteria: "Paint the door.",
      amount: BigInt(1_000_000),
      lock,
    });
    net.authorizePayment({
      id: "pay-job",
      payer: payer.address,
      receiver: worker.address,
      amount: task.amount,
      taskId: task.id,
      expiry: Date.now() + 60_000,
    });
    net.markAuthorized(task.id, "pay-job");
    await writeDocument("workspace:41", JSON.stringify({ cid: "bafyworkspace", history: ["bafyworkspace"], bootstrapComplete: true }));
    await saveDesk(net);
    await runHireJob(task.id, {
      supervisorWallet: supervisor.address,
      scanText: async () => ({ allow: true, reason: "Scanner allowed the text.", llama: "allow" }),
      callModel: async (instruction) => {
        assert.match(instruction, /Paint the door/);
        assert.equal(instruction.includes("USER.md"), false);
        return { files: [{ path: "index.html", text: "<p>Hello</p>" }], command: [], done: true };
      },
      runSandbox: async (job) => ({ ok: true, stdout: "", files: job.writes }),
    });
    const sealed = (await desk()).tasks.get(task.id);
    assert.equal(sealed?.status, "delivered");
    const log = sealed?.jobLog?.map((entry) => entry.text).join("\n") ?? "";
    assert.match(log, /Wrote index.html/);
    assert.match(log, /The delivery is sealed/);
    assert.equal(log.includes("<p>Hello</p>"), false);
    assert.equal(sealed?.deliveryReleased, false);
    assert.deepEqual(sealed?.artifactReaders, [supervisor.address]);
    assert.equal(
      sealedToSupervisor(sealed?.artifactReaders ?? [], supervisor.address, [payer.address, worker.address, workerOwner.address]),
      true,
    );
    assert.match((await readDocument("workspace:41")) ?? "", /bafyworkspace/);
    await assert.rejects(() => readReleasedDelivery(payer.address, task.id), /stays sealed/);

    delete holder.muselancerDesk;
    const restored = await desk();
    const again = restored.tasks.get(task.id);
    assert.equal(restored.artifactReaders(again?.artifactCid ?? ""), null);
    await ensureArtifactKey(restored, again?.artifactCid ?? "");
    assert.match(await restored.readArtifact(again?.artifactCid ?? "", supervisor.address), /<p>Hello<\/p>/);
    await assert.rejects(() => restored.readArtifact(again?.artifactCid ?? "", payer.address), /cannot open/);
    const exported = restored.publicExport().tasks.find((item) => item.id === task.id);
    assert.equal(exported !== undefined && "artifactKeyWrap" in exported, false);
    const storedTask = restored.snapshot().tasks.find((item) => item.id === task.id);
    assert.match(JSON.stringify(storedTask), /artifactKeyWrap/);

    if (again) again.supervisorReport = "It is HTML that appears to be a website or a landing page.";
    await saveDesk(restored);
    const sentBack = await settlementCall({ payer: payer.address, taskId: task.id, verdict: "needs_revision" });
    assert.equal("status" in sentBack && sentBack.status, "revision");
    assert.equal(restored.getPayment("pay-job")?.status, "authorized");
    const firstCid = again?.artifactCid;
    let previous = "";
    await runHireJob(task.id, {
      supervisorWallet: supervisor.address,
      scanText: async () => ({ allow: true, reason: "Scanner allowed the text.", llama: "allow" }),
      callModel: async (instruction) => {
        assert.match(instruction, /sent this delivery back/);
        return { files: [{ path: "index.html", text: "<p>Revised</p>" }], command: [], done: true };
      },
      runSandbox: async (job) => {
        previous = job.files.find((file) => file.path === "index.html")?.text ?? "";
        return { ok: true, stdout: "", files: job.writes };
      },
    });
    assert.match(previous, /Hello/);
    const revised = (await desk()).tasks.get(task.id);
    assert.equal(revised?.status, "delivered");
    assert.equal(revised?.supervisorReport ?? null, null);
    assert.equal(revised?.deliveryReleased, false);
    assert.notEqual(revised?.artifactCid, firstCid);

    applyVerifiedVerdict(await desk(), task.id, "pass");
    const released = await readReleasedDelivery(payer.address, task.id);
    assert.equal(released.files[0]?.text, "<p>Revised</p>");
    await assert.rejects(() => readReleasedDelivery(workerOwner.address, task.id), /Only the hirer/);

    const voidLock = buildHireLock({
      payer: payer.address,
      receiver: worker.address,
      amount: "1000000",
      operator: payer.address,
      now: Math.floor(Date.now() / 1000),
      salt: `0x${"66".repeat(32)}` as Hex,
    });
    const voidTask = (await desk()).openTask({
      id: "dd".repeat(16),
      buyerAgentId: payer.address,
      workerAgentId: "41",
      criteria: "Paint the door.",
      amount: BigInt(1_000_000),
      lock: voidLock,
    });
    (await desk()).authorizePayment({
      id: "pay-void",
      payer: payer.address,
      receiver: worker.address,
      amount: voidTask.amount,
      taskId: voidTask.id,
      expiry: Date.now() + 60_000,
    });
    (await desk()).markAuthorized(voidTask.id, "pay-void");
    await saveDesk(await desk());
    await runHireJob(voidTask.id, {
      supervisorWallet: supervisor.address,
      scanText: async () => ({ allow: true, reason: "Scanner allowed the text.", llama: "allow" }),
      callModel: async () => ({ files: [{ path: "index.html", text: "<p>Void</p>" }], command: [], done: true }),
      runSandbox: async (job) => ({ ok: true, stdout: "", files: job.writes }),
    });
    const voided = applyVerifiedVerdict(await desk(), voidTask.id, "fail");
    assert.equal(voided.deliveryReleased, false);
    assert.equal(voided.artifactKeyWrap, undefined);
    await assert.rejects(() => readReleasedDelivery(payer.address, voidTask.id), /stays sealed/);

    const failed = (await desk()).openTask({
      id: "ee".repeat(16),
      buyerAgentId: payer.address,
      workerAgentId: "41",
      criteria: "Paint the door.",
      amount: BigInt(1_000_000),
      lock: { ...lock, salt: `0x${"77".repeat(32)}` as Hex },
    });
    (await desk()).authorizePayment({
      id: "pay-fail",
      payer: payer.address,
      receiver: worker.address,
      amount: failed.amount,
      taskId: failed.id,
      expiry: Date.now() + 60_000,
    });
    (await desk()).markAuthorized(failed.id, "pay-fail");
    await saveDesk(await desk());
    await runHireJob(failed.id, {
      supervisorWallet: supervisor.address,
      scanText: async () => ({ allow: true, reason: "Scanner allowed the text.", llama: "allow" }),
      callModel: async () => {
        throw new Error("The sandbox did not run.");
      },
      runSandbox: async () => ({ ok: true, stdout: "", files: [] }),
    });
    const stopped = (await desk()).tasks.get(failed.id);
    assert.equal(stopped?.status, "authorized");
    assert.equal(stopped?.artifactCid ?? null, null);
    assert.match(stopped?.jobError ?? "", /sandbox did not run/);
    const decline = await settlementCall({ payer: payer.address, taskId: failed.id, verdict: "fail" });
    assert.equal("void" in decline && Boolean(decline.void), true);
    assert.equal((await desk()).getPayment("pay-fail")?.status, "authorized");

    const hanging = (await desk()).openTask({
      id: "ff".repeat(16),
      buyerAgentId: payer.address,
      workerAgentId: "41",
      criteria: "Paint the door.",
      amount: BigInt(1_000_000),
      lock: { ...lock, salt: `0x${"88".repeat(32)}` as Hex },
    });
    hanging.status = "running";
    const hangingRevision = (await desk()).openTask({
      id: "ab".repeat(16),
      buyerAgentId: payer.address,
      workerAgentId: "41",
      criteria: "Paint the door.",
      amount: BigInt(1_000_000),
      lock: { ...lock, salt: `0x${"99".repeat(32)}` as Hex },
    });
    hangingRevision.status = "running";
    hangingRevision.artifactCid = "bafykeep";
    await saveDesk(await desk());
    delete holder.muselancerDesk;
    const woken = await desk();
    assert.equal(woken.tasks.get(hanging.id)?.status, "authorized");
    assert.match(woken.tasks.get(hanging.id)?.jobError ?? "", /sandbox stopped/);
    assert.equal(woken.tasks.get(hangingRevision.id)?.status, "revision");
    assert.equal(woken.tasks.get(hangingRevision.id)?.artifactCid, "bafykeep");
  } finally {
    if (previousDoc) await writeDocument("network", previousDoc);
    else await deleteDocument("network");
    await deleteDocument("workspace:41");
    if (previousSecret === undefined) delete process.env.MUSELANCER_SECRET;
    else process.env.MUSELANCER_SECRET = previousSecret;
    holder.muselancerDesk = previousNet;
  }
});

test("a hire thread is the two agents and leaves the owner chat out", () => {
  const messages = dealMessages({
    hiringName: "Muse voice",
    workerName: "Muse dev",
    brief: "Build a landing page.",
    offers: [
      { side: "buyer", action: "offer", priceLabel: "5", deadline: "2026-11-04", reason: "Offer inside the owner's budget." },
      { side: "worker", action: "accept", priceLabel: "5", deadline: "2026-11-04", reason: "I can write the page." },
      { side: "buyer", action: "offer", priceLabel: "5", deadline: "2026-11-04", reason: "Offer inside the owner's budget." },
    ],
  });
  assert.equal(messages[0]?.text, "Build a landing page.\n\nI can pay 5 USDC, deliver by 2026-11-04.");
  assert.equal(messages[0]?.speaker, "Muse voice");
  assert.equal(messages[0]?.kind, "hiring");
  assert.equal(messages[1]?.text, "I can write the page.");
  assert.equal(messages[1]?.speaker, "Muse dev");
  assert.equal(messages[1]?.kind, "worker");
  assert.equal(messages[2]?.text, "I can pay 5 USDC, deliver by 2026-11-04.");
  assert.equal(messages.map((message) => message.text).join("\n").includes("You"), false);
  const handed = dealMessages({
    hiringName: "Muse voice",
    workerName: "Muse dev",
    brief: "let's hire for a landing page",
    work: "let's hire for a landing page\n\nClarified:\nA page for Muse Voice Transcribe.",
    offers: [{ side: "buyer", action: "offer", priceLabel: "5", deadline: "2026-11-04", reason: "Offer inside the owner's budget." }],
  });
  assert.match(handed[0]?.text ?? "", /Clarified:\nA page for Muse Voice Transcribe/);
  assert.match(handed[0]?.text ?? "", /I can pay 5 USDC/);
  assert.equal(handed[0]?.text.includes("let's hire for a landing page\n\nlet's hire"), false);
  const sealedOnly = dealMessages({
    hiringName: "Muse voice",
    workerName: "Muse dev",
    work: "Build the page.\n\nClarified:\nHero and FAQ.",
    offers: [],
  });
  assert.equal(sealedOnly.length, 1);
  assert.match(sealedOnly[0]?.text ?? "", /Hero and FAQ/);
  assert.equal(dealMessages({ hiringName: "Muse voice", workerName: "Muse dev", offers: [] }).length, 0);
  assert.equal(deliveryFileKind("site/index.html"), "code");
  assert.equal(deliveryFileKind("shot.png"), "image");
  assert.equal(deliveryFileKind("bundle.zip"), "file");
});

test("the supervisor authorization key is the P-256 key Privy signs with", () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const stored = `wallet-auth:${Buffer.from(privateKey.export({ format: "der", type: "pkcs8" })).toString("base64")}`;
  const publicKey = authorizationPublicKey(stored);
  assert.match(publicKey, /^[A-Za-z0-9+/]+=*$/);
  assert.doesNotThrow(() => new PrivyClient("app", "secret", { walletApi: { authorizationPrivateKey: stored } }));
});
