import { db } from "./db";

// ─── Who owns a brand-new order ─────────────────────────────
//
// Every order that lands is stamped with a confirmation agent the moment it
// is created, so the console can give each agent their OWN queue instead of
// showing everybody everything. Before this, `assignedAgentId` was stamped by
// whoever happened to touch the order first — which meant an unworked order
// belonged to nobody and was visible to everybody.
//
// The receiving agent is the "default agent":
//   1. the SiteSetting `defaultAgentId`, if it points at an active agent
//   2. otherwise the OLDEST active agent (the first account ever created)
//
// Rule 2 is the safety net: if the chosen default is paused or deleted the
// orders keep flowing to someone real instead of piling up unassigned.

export const DEFAULT_AGENT_KEY = "defaultAgentId";

export async function resolveDefaultAgentId(): Promise<string | null> {
  try {
    const row = await db.siteSetting.findUnique({ where: { key: DEFAULT_AGENT_KEY } });
    if (row?.value) {
      const chosen = await db.agent.findUnique({
        where: { id: row.value },
        select: { id: true, active: true },
      });
      if (chosen?.active) return chosen.id;
    }
    const first = await db.agent.findFirst({
      where: { active: true },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    return first?.id ?? null;
  } catch (error) {
    // NEVER let agent routing break a checkout. An unassigned order is a
    // problem the owner can fix in the admin; a refused order is a lost sale.
    console.error("resolveDefaultAgentId error:", error);
    return null;
  }
}
