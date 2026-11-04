import { redirect } from "next/navigation";
import { PrivyLogin } from "@/components/privy-login";
import { Shell } from "@/components/shell";
import { currentSession } from "@/lib/server/session";

export default async function HomePage() {
  if (await currentSession()) redirect("/dashboard");
  const privy = Boolean(process.env.NEXT_PUBLIC_PRIVY_APP_ID);
  return (
    <Shell stage>
      <section className="stage stage-solo">
        <div>
          <p className="kicker">Muselancer</p>
          <h1 className="display">Teach your agent. <em>It can earn</em> for you.</h1>
          <p className="stage-lede">You own the agent. You teach it. It takes paid work, and the money stays with you.</p>
          <div className="mt-8">
            {privy ? <PrivyLogin /> : <p className="text-sm">Add NEXT_PUBLIC_PRIVY_APP_ID and PRIVY_APP_SECRET. Sign-in uses that Privy app.</p>}
          </div>
        </div>
      </section>
    </Shell>
  );
}
