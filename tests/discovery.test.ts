import assert from "node:assert/strict";
import test from "node:test";
import { zeroAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { AUTH_CAPTURE_ESCROW, IDENTITY_CHAIN_ID, IDENTITY_IMPLEMENTATION, IDENTITY_REGISTRY } from "../lib/chain/constants";
import { directoryEndpoint, isTailnetIp } from "../lib/directory/address";
import { directoryRequestError } from "../lib/directory/client";
import { verifyDirectoryRecord } from "../lib/directory/verify";
import { assertPinnedImplementation } from "../lib/identity/implementation";
import { buildDirectoryRecord } from "../lib/protocol/directory-record";
import { buildOasfRecord, canonicalJson, parseCanonicalJson } from "../lib/protocol/oasf";
import { defaultPolicy } from "../lib/protocol/policy";
import { agentRegistryId } from "../lib/protocol/registration";
import { skillChoicesFromTaxonomy } from "../lib/protocol/skills";
import { saveDesk } from "../lib/server/desk";
import { directorySearch, listOwned } from "../lib/server/register";
import { isPlatformSupervisor } from "../lib/server/supervisor-id";
import { freshAccount, Network } from "../lib/world/network";

process.env.MUSELANCER_SECRET = "test-secret-not-used-in-production";
process.env.MUSELANCER_DB = ":memory:";
process.env.SUPERVISOR_PRIVATE_KEY = `0x${"11".repeat(32)}`;
process.env.NEXT_PUBLIC_APP_URL = "https://muselancer.example";

const CREATED_AT = "2026-10-28T21:00:00Z";
const TAXONOMY = new Map([[201, "images_computer_vision/image_segmentation"]]);

function implementationSlot(address: string): Hex {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}` as Hex;
}

function signedRecord() {
  const owner = privateKeyToAccount(generatePrivateKey());
  const wallet = privateKeyToAccount(generatePrivateKey());
  const message = buildDirectoryRecord({
    displayName: "Writer",
    description: "Writes a one-page brief.",
    skillIds: [201],
    taxonomy: TAXONOMY,
    agentId: "42",
    agentWallet: wallet.address,
    owner: owner.address,
    createdAt: CREATED_AT,
    origin: "https://muselancer.example",
  });
  return { owner, wallet, message };
}

test("a directory record is schema-valid OASF and verifies against the pinned registry", async () => {
  const { owner, wallet, message } = signedRecord();
  const parsed = parseCanonicalJson(message) as {
    schema_version: string;
    version: string;
    name: string;
    created_at: string;
    skills: { id: number; name: string }[];
    locators: { type: string; urls: string[] }[];
    annotations: Record<string, string>;
  };
  assert.equal(parsed.schema_version, "1.0.0");
  assert.equal(parsed.version, "v1.0.0");
  assert.equal(parsed.created_at, CREATED_AT);
  assert.equal(parsed.skills[0]?.id, 201);
  assert.equal(parsed.skills[0]?.name, "images_computer_vision/image_segmentation");
  assert.deepEqual(parsed.locators, [{ type: "url", urls: ["https://muselancer.example/api/agents/42/oasf"] }]);
  assert.equal(parsed.name, "https://muselancer.example/api/agents/42/oasf");
  assert.equal(parsed.annotations["muselancer.registry"], agentRegistryId());
  assert.equal(parsed.annotations["muselancer.chainId"], String(IDENTITY_CHAIN_ID));
  assert.equal(parsed.annotations["muselancer.agentId"], "42");
  assert.equal(parsed.annotations["muselancer.owner"], owner.address);
  assert.equal(parsed.annotations["muselancer.agentWallet"], wallet.address);
  assert.equal(parsed.annotations["muselancer.displayName"], "Writer");
  assert.equal(agentRegistryId(), `eip155:${IDENTITY_CHAIN_ID}:${IDENTITY_REGISTRY}`);
  const signature = await wallet.signMessage({ message });
  const verdict = await verifyDirectoryRecord({
    recordJson: message,
    taxonomy: TAXONOMY,
    implementationSlot: implementationSlot(IDENTITY_IMPLEMENTATION),
    chain: { owner: owner.address, agentWallet: wallet.address, oasfMessage: message, oasfSignature: signature },
  });
  assert.equal(verdict.ok, true);
  if (verdict.ok) {
    assert.equal(verdict.agent.displayName, "Writer");
    assert.equal(verdict.agent.agentId, "42");
    assert.equal(verdict.agent.owner, owner.address);
    assert.equal(verdict.agent.agentWallet, wallet.address);
    assert.equal(verdict.agent.registry, agentRegistryId());
  }
});

test("an unknown skill id is rejected", () => {
  const owner = privateKeyToAccount(generatePrivateKey());
  const wallet = privateKeyToAccount(generatePrivateKey());
  assert.throws(
    () =>
      buildDirectoryRecord({
        displayName: "Writer",
        description: "Writes a one-page brief.",
        skillIds: [999],
        taxonomy: TAXONOMY,
        agentId: "42",
        agentWallet: wallet.address,
        owner: owner.address,
        createdAt: CREATED_AT,
        origin: "https://muselancer.example",
      }),
    /Skill id 999 is not in the OASF taxonomy/,
  );
  const choices = skillChoicesFromTaxonomy({
    images_computer_vision: {
      id: 2,
      name: "images_computer_vision",
      caption: "Images / Computer Vision",
      description: "Images.",
      category: true,
      classes: {
        image_segmentation: {
          id: 201,
          name: "images_computer_vision/image_segmentation",
          caption: "Image Segmentation",
          description: "Assigning labels or categories to images based on their visual content.",
        },
        image_processing: {
          id: 701,
          name: "multi_modal/image_processing",
          caption: "Image Processing",
          description: "Images and text.",
          classes: {
            image_to_text: {
              id: 70101,
              name: "multi_modal/image_processing/image_to_text",
              caption: "Image to Text",
              description: "Captions for images.",
            },
          },
        },
      },
    },
  });
  const segmentation = choices.find((skill) => skill.id === 201);
  assert.equal(segmentation?.caption, "Image Segmentation");
  assert.equal(segmentation?.name, "images_computer_vision/image_segmentation");
  assert.equal(segmentation?.category, "Images / Computer Vision");
  assert.equal(choices.find((skill) => skill.id === 70101)?.name, "multi_modal/image_processing/image_to_text");
  assert.equal(choices.some((skill) => skill.id === 2), false);
  assert.equal(choices.find((skill) => skill.id === 701)?.caption, "Image Processing");
  assert.equal(choices.some((skill) => skill.id === 999), false);
  assert.throws(() => skillChoicesFromTaxonomy({}), /Could not read the OASF skill taxonomy/);
});

test("a record that names another registry is rejected", async () => {
  const { owner, wallet, message } = signedRecord();
  const parsed = JSON.parse(message) as { annotations: Record<string, string> };
  const stranger = privateKeyToAccount(generatePrivateKey());
  parsed.annotations["muselancer.registry"] = `eip155:${IDENTITY_CHAIN_ID}:${stranger.address}`;
  const renamed = canonicalJson(parsed);
  const signature = await wallet.signMessage({ message: renamed });
  const verdict = await verifyDirectoryRecord({
    recordJson: renamed,
    taxonomy: TAXONOMY,
    implementationSlot: implementationSlot(IDENTITY_IMPLEMENTATION),
    chain: { owner: owner.address, agentWallet: wallet.address, oasfMessage: renamed, oasfSignature: signature },
  });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /registry/);
});

test("a signature over edited bytes is rejected", async () => {
  const { owner, wallet, message } = signedRecord();
  const signature = await wallet.signMessage({ message });
  const parsed = JSON.parse(message) as { description: string };
  parsed.description = "Edited brief.";
  const edited = canonicalJson(parsed);
  const verdict = await verifyDirectoryRecord({
    recordJson: edited,
    taxonomy: TAXONOMY,
    implementationSlot: implementationSlot(IDENTITY_IMPLEMENTATION),
    chain: { owner: owner.address, agentWallet: wallet.address, oasfMessage: edited, oasfSignature: signature },
  });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /signature/);
});

test("a zero agent wallet is rejected", async () => {
  const { owner, wallet, message } = signedRecord();
  const signature = await wallet.signMessage({ message });
  const verdict = await verifyDirectoryRecord({
    recordJson: message,
    taxonomy: TAXONOMY,
    implementationSlot: implementationSlot(IDENTITY_IMPLEMENTATION),
    chain: { owner: owner.address, agentWallet: zeroAddress, oasfMessage: message, oasfSignature: signature },
  });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /wallet/);
});

test("an implementation slot mismatch stops discovery", () => {
  assert.throws(() => assertPinnedImplementation(implementationSlot(zeroAddress)), /implementation changed/);
  assert.doesNotThrow(() => assertPinnedImplementation(implementationSlot(IDENTITY_IMPLEMENTATION)));
});

test("ownerOf must match the signed owner", async () => {
  const { wallet, message } = signedRecord();
  const stranger = privateKeyToAccount(generatePrivateKey());
  const signature = await wallet.signMessage({ message });
  const verdict = await verifyDirectoryRecord({
    recordJson: message,
    taxonomy: TAXONOMY,
    implementationSlot: implementationSlot(IDENTITY_IMPLEMENTATION),
    chain: { owner: stranger.address, agentWallet: wallet.address, oasfMessage: message, oasfSignature: signature },
  });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /ownerOf/);
});

test("canonical JSON rejects duplicate keys, fractional skill ids, and non-checksum addresses", () => {
  assert.throws(() => parseCanonicalJson('{"a":1,"a":2}'), /duplicate key/);
  assert.throws(() => parseCanonicalJson('{"id":201.5}'), /non-integer/);
  const owner = privateKeyToAccount(generatePrivateKey());
  const wallet = privateKeyToAccount(generatePrivateKey());
  assert.throws(
    () =>
      buildDirectoryRecord({
        displayName: "Writer",
        description: "Writes a one-page brief.",
        skillIds: [201],
        taxonomy: TAXONOMY,
        agentId: "42",
        agentWallet: wallet.address.toLowerCase(),
        owner: owner.address,
        createdAt: CREATED_AT,
        origin: "https://muselancer.example",
      }),
    /checksum/,
  );
});

test("directory search does not treat the local desk as a result", async () => {
  const previous = process.env.DIRECTORY_CLIENT_SERVER_ADDRESS;
  delete process.env.DIRECTORY_CLIENT_SERVER_ADDRESS;
  try {
    const net = new Network();
    const owner = freshAccount();
    const wallet = freshAccount();
    const agent = net.mintAgent({
      owner: owner.address,
      agentWallet: wallet.address,
      agentUri: "",
      policy: {
        ...defaultPolicy(),
        allowedActions: ["discover"],
        perTaskCapUsdc: "1000000",
        dailyBudgetUsdc: "1000000",
        allowedRecipients: [AUTH_CAPTURE_ESCROW.toLowerCase()],
      },
    });
    const record = buildOasfRecord({
      nameUrl: "https://muselancer.example/agents/writer",
      description: "Writes a one-page brief.",
      skillIds: [201],
      agentId: agent.agentId,
      agentWallet: wallet.address,
      owner: owner.address,
      oasfCid: "pending",
    });
    await net.publishOasf({ record, signature: await wallet.signMessage({ message: canonicalJson(record) }) });
    await saveDesk(net);
    await assert.rejects(() => directorySearch(201), /Set DIRECTORY_CLIENT_SERVER_ADDRESS/);
    await assert.rejects(() => listOwned(owner.address), /Set DIRECTORY_CLIENT_SERVER_ADDRESS/);
  } finally {
    if (previous === undefined) delete process.env.DIRECTORY_CLIENT_SERVER_ADDRESS;
    else process.env.DIRECTORY_CLIENT_SERVER_ADDRESS = previous;
  }
});

test("the platform supervisor is left out of discovery and hire search", () => {
  assert.equal(isPlatformSupervisor({ agentId: "9", displayName: "Muselancer supervisor" }, null), true);
  assert.equal(isPlatformSupervisor({ agentId: "9", displayName: "Writer" }, "9"), true);
  assert.equal(isPlatformSupervisor({ agentId: "8", displayName: "Writer" }, "9"), false);
  assert.equal(isPlatformSupervisor({ agentId: "8", displayName: "Muselancer supervisor agent" }, "9"), false);
});

test("an unreachable directory names the missing connection", () => {
  const error = directoryRequestError(new Error("[unavailable]"), "example.ts.net:8888");
  assert.match(error.message, /Directory request failed: the server cannot reach the Directory node/);
  assert.match(directoryRequestError(new Error("ECONNREFUSED"), "203.0.113.10:8888").message, /did not accept a connection/);
  assert.match(directoryRequestError(new Error("record rejected"), "example.ts.net:8888").message, /record rejected/);
  assert.equal(
    directoryRequestError(new Error("Directory request failed: the server cannot reach the Directory node.")).message,
    "Directory request failed: the server cannot reach the Directory node.",
  );
});

test("directory gRPC accepts a public host and port", () => {
  assert.throws(() => directoryEndpoint(""), /Set DIRECTORY_CLIENT_SERVER_ADDRESS/);
  assert.throws(() => directoryEndpoint("1.2.3.4"), /must include a port/);
  assert.deepEqual(directoryEndpoint("1.2.3.4:8888"), { address: "1.2.3.4:8888", authMode: "" });
  assert.deepEqual(directoryEndpoint("localhost:8888"), { address: "localhost:8888", authMode: "" });
  assert.deepEqual(directoryEndpoint("127.0.0.1:8888"), { address: "127.0.0.1:8888", authMode: "" });
  assert.deepEqual(directoryEndpoint("vmi3706410.tail1f7cd2.ts.net:8888"), {
    address: "vmi3706410.tail1f7cd2.ts.net:8888",
    authMode: "",
  });
  assert.deepEqual(directoryEndpoint("https://dir.example.com:443"), { address: "dir.example.com:443", authMode: "tls" });
  assert.equal(isTailnetIp("100.64.0.1"), true);
  assert.equal(isTailnetIp("100.127.255.1"), true);
  assert.equal(isTailnetIp("100.63.0.1"), false);
  assert.equal(isTailnetIp("185.40.234.55"), false);
  assert.equal(isTailnetIp("fd7a:115c:a1e0::1"), true);
});
