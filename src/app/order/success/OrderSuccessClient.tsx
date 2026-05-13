"use client";

// src/app/order/success/OrderSuccessClient.tsx
//
// Phase 8 — client component that polls Confirmi's public status
// endpoint and renders the countdown / status pill the prospect sees
// in the 60-120s between order placement and Amina's ring.

import { useEffect, useMemo, useState } from "react";

const POLL_INTERVAL_MS = 2000;

type Status =
  | "pending"
  | "dispatching"
  | "dispatched"
  | "failed"
  | "skipped"
  | "unknown";

type ConfirmiStatusResponse = {
  ok: boolean;
  status: Status;
  scheduledFor: string | null;
  secondsUntilDispatch: number | null;
  dispatchedAt: string | null;
  dispatchedCallId: string | null;
  lastError: string | null;
};

export function OrderSuccessClient({
  orderNumber,
  confirmiBase,
  source,
}: {
  orderNumber: string;
  confirmiBase: string;
  source: string;
}) {
  const [snapshot, setSnapshot] = useState<ConfirmiStatusResponse | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);

  useEffect(() => {
    if (!confirmiBase) return;
    let stopped = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    async function tick(): Promise<void> {
      if (stopped) return;
      try {
        const url = `${confirmiBase.replace(/\/+$/, "")}/api/integrations/livesite/order/${encodeURIComponent(orderNumber)}/status?source=${encodeURIComponent(source)}`;
        const res = await fetch(url, { cache: "no-store" });
        if (res.ok) {
          const json = (await res.json()) as ConfirmiStatusResponse;
          if (!stopped) {
            setSnapshot(json);
            setPollError(null);
          }
        }
      } catch (err) {
        if (!stopped) setPollError((err as Error).message);
      }
      if (!stopped) {
        timeoutId = setTimeout(tick, POLL_INTERVAL_MS);
      }
    }
    tick();

    return () => {
      stopped = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [confirmiBase, orderNumber, source]);

  // Local timer that ticks down every 500ms so the displayed seconds
  // feel responsive between 2-second poll cycles.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  const status = snapshot?.status ?? "unknown";
  const secondsLeft = useMemo(() => {
    if (!snapshot?.scheduledFor || snapshot.status !== "pending") return null;
    const t = new Date(snapshot.scheduledFor).getTime();
    return Math.max(0, Math.ceil((t - now) / 1000));
  }, [snapshot, now]);

  if (!confirmiBase) {
    return (
      <p className="text-sm text-neutral-400 text-center">
        تسجيل الطلب تم. غادي تتصل بيك الفريق قريبا للتأكيد.
      </p>
    );
  }

  if (status === "unknown" && !snapshot) {
    return (
      <p className="text-sm text-neutral-400 text-center animate-pulse">
        جاري تحضير المكالمة…
      </p>
    );
  }

  if (status === "skipped" || status === "failed" || status === "unknown") {
    return (
      <div className="space-y-2 text-center">
        <p className="text-sm text-neutral-300">
          غادي يعيطلك الفريق قريبا باش يأكدلك الطلب.
        </p>
        <p className="text-xs text-neutral-500">رقم الطلب: #{orderNumber}</p>
        {pollError && (
          <p className="text-[10px] text-neutral-600">
            (debug: {pollError.slice(0, 100)})
          </p>
        )}
      </div>
    );
  }

  if (status === "pending") {
    return (
      <div className="space-y-4 text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-300">
          <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
          راه يحضر التصال
        </div>
        <div>
          <div className="font-mono text-6xl font-bold tabular-nums text-emerald-400">
            {secondsLeft ?? "—"}
          </div>
          <p className="mt-2 text-sm text-neutral-300">
            ثانية وغادي يعيطلك <strong className="text-white">أمين</strong> من
            Confirmi.
          </p>
          <p className="mt-1 text-xs text-neutral-500">
            حضّر تليفونك، اجعلو على الطاولة بصوت عالي.
          </p>
        </div>
        <p className="text-xs text-neutral-500">رقم الطلب: #{orderNumber}</p>
      </div>
    );
  }

  if (status === "dispatching") {
    return (
      <div className="space-y-3 text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-blue-500/40 bg-blue-500/10 px-3 py-1 text-xs font-medium text-blue-300">
          <span className="h-2 w-2 rounded-full bg-blue-400 animate-ping" />
          راه يعيط ليك توا
        </div>
        <p className="text-sm text-neutral-300">جاوب التليفون 📱</p>
        <p className="text-xs text-neutral-500">رقم الطلب: #{orderNumber}</p>
      </div>
    );
  }

  // dispatched — the bridge accepted the dial; phone is ringing or
  // about to ring in the next ~5-15s. NOT the "call complete" state —
  // there's no terminal "ended" state in this v1 status endpoint.
  return (
    <div className="space-y-3 text-center">
      <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300">
        <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
        التصال راه يدير الرنين
      </div>
      <p className="text-sm text-neutral-300">
        جاوب التليفون 📱 ـ أمين راه يحضر بش يعيط ليك
      </p>
      <p className="text-xs text-neutral-500">رقم الطلب: #{orderNumber}</p>
    </div>
  );
}
