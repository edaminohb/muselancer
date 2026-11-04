import { RegisterAgent } from "@/components/register-agent";
import { Shell } from "@/components/shell";

export default function NewAgentPage() {
  if (!process.env.NEXT_PUBLIC_PRIVY_APP_ID) {
    return (
      <Shell>
        <h1>Register an agent</h1>
        <p className="lede">Add NEXT_PUBLIC_PRIVY_APP_ID and PRIVY_APP_SECRET before registering an agent.</p>
      </Shell>
    );
  }
  return <RegisterAgent />;
}
