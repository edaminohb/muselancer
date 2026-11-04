import { NextResponse } from "next/server";
import { assertRegistrationSkills } from "@/lib/protocol/skills";
import { prepareRegistration, registrationDraft } from "@/lib/server/register";
import { currentSession } from "@/lib/server/session";

export async function GET() {
  const session = await currentSession();
  if (!session) return NextResponse.json({ draft: null });
  try {
    const draft = await registrationDraft(session.ownerAddress);
    return NextResponse.json({ draft });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read the saved registration.";
    return NextResponse.json({ error: message, draft: null }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const body = (await request.json()) as { name?: string; description?: string; skillIds?: number[]; model?: string };
  const name = (body.name ?? "").trim();
  const description = (body.description ?? "").trim();
  if (!name || !description) return NextResponse.json({ error: "Name and description are required." }, { status: 400 });
  if (!Array.isArray(body.skillIds)) {
    return NextResponse.json({ error: "Choose 1 to 5 OASF skills." }, { status: 400 });
  }
  try {
    assertRegistrationSkills(body.skillIds);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Choose 1 to 5 OASF skills.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
  if (!body.model?.trim()) return NextResponse.json({ error: "Choose a model." }, { status: 400 });
  try {
    const challenge = await prepareRegistration({
      owner: session.ownerAddress,
      agentWallet: session.agentWallet,
      name,
      description,
      skillIds: body.skillIds,
      model: body.model,
    });
    return NextResponse.json(challenge);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not prepare registration.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
