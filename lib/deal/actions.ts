export type HireChoice = { label: string; message: string };

export type OwnerControls = {
  note: string;
  choices: HireChoice[];
  form: boolean;
  lock: boolean;
};

type ControlDeal = {
  stage: string;
  pendingAsk: { question: string } | null;
  pendingCounter: { priceLabel: string } | null;
  current: { name: string } | null;
  selectedAgentId: string | null;
  budgetLabel: string | null;
  deadline: string | null;
  needsWindow: boolean;
};

const CANCEL_HIRE: HireChoice = { label: "Cancel this hire", message: "Cancel this hire." };

function withCancel(controls: OwnerControls): OwnerControls {
  return { ...controls, choices: [...controls.choices, CANCEL_HIRE] };
}

/** Buttons and fields for the choice the hire is waiting on. */
export function ownerControls(deal: ControlDeal | null): OwnerControls | null {
  if (!deal || deal.pendingAsk || deal.stage === "brief" || deal.stage === "locked") return null;
  if (deal.stage === "suggest" && deal.current) {
    return withCancel({
      note: `Accept or reject ${deal.current.name}.`,
      choices: [
        { label: "Accept", message: "accept" },
        { label: "Reject", message: "reject" },
      ],
      form: false,
      lock: false,
    });
  }
  if (deal.pendingCounter) {
    return withCancel({
      note: `The other agent asks for ${deal.pendingCounter.priceLabel} USDC.`,
      choices: [
        { label: "Accept counter", message: "accept" },
        { label: "Reject counter", message: "reject" },
      ],
      form: false,
      lock: false,
    });
  }
  if (deal.stage === "confirm") {
    return withCancel({
      note: "The terms are agreed. Press Confirm and lock USDC. The supervisor is deployed when you confirm.",
      choices: [],
      form: false,
      lock: true,
    });
  }
  if (deal.stage !== "terms" && deal.stage !== "negotiate" && deal.stage !== "stopped") return null;
  if (!deal.selectedAgentId && !deal.needsWindow) return null;
  const ready = Boolean(deal.budgetLabel && deal.deadline);
  return withCancel({
    note: deal.needsWindow
      ? "The delivery day is past the seven-day lock. Set a closer day, or continue with the seven-day window."
      : ready
        ? "Continue closes the terms at the price that fits the budget."
        : "Set the USDC budget and the delivery day.",
    choices: ready ? [{ label: "Continue", message: "continue" }] : [],
    form: deal.needsWindow || !ready,
    lock: false,
  });
}

/** The prompt on screen. A later hire step has a different identity, so it can be shown after this one is answered. */
export function controlIdentity(deal: ControlDeal | null): string {
  const controls = ownerControls(deal);
  if (!controls || !deal) return "";
  return JSON.stringify([
    deal.stage,
    controls.note,
    controls.form,
    controls.lock,
    controls.choices.map((choice) => `${choice.label}:${choice.message}`),
    deal.budgetLabel,
    deal.deadline,
    deal.needsWindow,
    deal.pendingAsk?.question ?? "",
    deal.pendingCounter?.priceLabel ?? "",
    deal.current?.name ?? "",
  ]);
}
