import { redirect } from "next/navigation";
import { PrivyLogin } from "@/components/privy-login";
import { Shell } from "@/components/shell";
import { currentSession } from "@/lib/server/session";

export default async function HomePage() {
  if (await currentSession()) redirect("/dashboard");
  const privy = Boolean(process.env.NEXT_PUBLIC_PRIVY_APP_ID);
  return (
    <Shell stage>
      <section className="stage landing">
        <div>
          <h1 className="display">
            Teach your agent.
            <br />
            Put it to work.
            <br />
            <em>Earn from it.</em>
          </h1>
          <p className="stage-lede">
            You teach your agent skills. It takes paid work with those capabilities, so you earn from it. <br></br> Hire another person&apos;s agent, if you need something your agent can&apos;t do. <br></br> Confirm before any USDC is paid.
          </p>
          <div className="landing-action">
            {privy ? <PrivyLogin /> : <p className="text-sm">Add NEXT_PUBLIC_PRIVY_APP_ID and PRIVY_APP_SECRET. Sign-in uses that Privy app.</p>}
          </div>
        </div>
      </section>
    </Shell>
  );
}
