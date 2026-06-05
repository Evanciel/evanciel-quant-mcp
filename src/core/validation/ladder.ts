import { z } from "zod";

/**
 * tp_ladder 검증 (Design Ref: tp-ladder §3.4).
 * pct=익절선 상승률(%), sellPct=남은수량 대비 매도비율(%). pct 오름차순 강제.
 * 마지막 sellPct=100 권장(미만이면 잔량 runner 유지 — 의도적 moonbag 허용).
 */
export const LadderLevelSchema = z.object({
  pct: z.number().positive(),
  sellPct: z.number().min(1).max(100),
});

export const LadderSchema = z
  .array(LadderLevelSchema)
  .min(1, "tp_ladder는 최소 1레벨 필요")
  .max(20, "tp_ladder는 최대 20레벨")
  .refine((levels) => levels.every((l, i) => i === 0 || l.pct > levels[i - 1].pct), {
    message: "tp_ladder pct는 오름차순(중복 불가)이어야 합니다",
  });

export type LadderInput = z.infer<typeof LadderSchema>;

/** 안전 파서: 유효하면 라더 배열, 아니면 null(런타임 폴백=단일 SL/TP 경로). */
export function parseLadder(raw: unknown): LadderInput | null {
  if (raw == null) return null;
  const r = LadderSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/**
 * scale_in 검증 (v2 물타기). dropPct=평단 대비 하락률(%), addPct=base 수량 대비 추가비율(%).
 * dropPct 오름차순(깊어질수록). maxMultiple=총포지션 상한 배수(1~10, 마틴게일 폭발 방지).
 */
export const ScaleInLevelSchema = z.object({
  dropPct: z.number().positive(),
  addPct: z.number().positive().max(1000),
});

export const ScaleInSchema = z.object({
  ladder: z
    .array(ScaleInLevelSchema)
    .min(1, "scale_in ladder는 최소 1레벨")
    .max(20, "scale_in ladder는 최대 20레벨")
    .refine((levels) => levels.every((l, i) => i === 0 || l.dropPct > levels[i - 1].dropPct), {
      message: "scale_in dropPct는 오름차순(깊어지는 순)이어야 합니다",
    }),
  maxMultiple: z.number().min(1).max(10), // 총포지션 ≤ baseQty×maxMultiple
});

export type ScaleInInput = z.infer<typeof ScaleInSchema>;

/** 안전 파서: 유효하면 scale_in 설정, 아니면 null(스케일인 비활성). */
export function parseScaleIn(raw: unknown): ScaleInInput | null {
  if (raw == null) return null;
  const r = ScaleInSchema.safeParse(raw);
  return r.success ? r.data : null;
}

// ── 피라미딩(승자 추가매수, scale-in 상승 미러) ──
export const PyramidLevelSchema = z.object({
  risePct: z.number().positive(),
  addPct: z.number().positive().max(1000),
});

export const PyramidSchema = z.object({
  ladder: z
    .array(PyramidLevelSchema)
    .min(1, "pyramid ladder는 최소 1레벨")
    .max(20, "pyramid ladder는 최대 20레벨")
    .refine((levels) => levels.every((l, i) => i === 0 || l.risePct > levels[i - 1].risePct), {
      message: "pyramid risePct는 오름차순(높아지는 순)이어야 합니다",
    }),
  maxMultiple: z.number().min(1).max(10), // 총포지션 ≤ baseQty×maxMultiple (마틴게일/폭주 방지)
});

export type PyramidInput = z.infer<typeof PyramidSchema>;

/** 안전 파서: 유효하면 pyramid 설정, 아니면 null(피라미딩 비활성). */
export function parsePyramid(raw: unknown): PyramidInput | null {
  if (raw == null) return null;
  const r = PyramidSchema.safeParse(raw);
  return r.success ? r.data : null;
}
