import fs from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";

type Score = Record<string, number>;
type Prospect = {
	pid: number;
	pos: string;
	score: Score;
	fit: { draftValue: number };
};
type Incumbent = { pid: number; pos: string; age: number; score: Score };
type Decision = {
	season: number;
	tid: number;
	pick: number;
	pid: number;
	strategy: string;
	record: number[];
	candidates: Prospect[];
	roster: Incumbent[];
};
type Report = { seed: number; draftDecisions: Decision[] };
const starters: Record<string, number> = {
	QB: 1,
	RB: 1,
	WR: 3,
	TE: 1,
	OL: 5,
	DL: 4,
	LB: 2,
	CB: 3,
	S: 2,
	K: 1,
	P: 1,
};
const targets: Record<string, number> = {
	QB: 2,
	RB: 4,
	WR: 6,
	TE: 3,
	OL: 9,
	DL: 9,
	LB: 7,
	CB: 5,
	S: 5,
	K: 1,
	P: 1,
};
const oldWeights: Record<string, number> = {
	QB: 0.14,
	RB: 0.065,
	WR: 0.07,
	TE: 0.05,
	OL: 0.09,
	DL: 0.1,
	LB: 0.07,
	CB: 0.08,
	S: 0.065,
	K: 0.035,
	P: 0.025,
};
// Explicit sensitivity experiments, not an optimizer fitting draft percentages.
const revisedWeights = { ...oldWeights, WR: 0.095, OL: 0.075, CB: 0.065 };
const variants = [
	{ name: "current" },
	{ name: "without incumbent performance", noPerformance: true },
	{ name: "position weights only", weights: revisedWeights },
	{ name: "smooth competition only", smooth: true },
	{ name: "weights and competition", weights: revisedWeights, smooth: true },
];
type Variant = {
	name: string;
	noPerformance?: boolean;
	weights?: Record<string, number>;
	smooth?: boolean;
};
const read = async (path: string): Promise<Report> =>
	JSON.parse(gunzipSync(await fs.readFile(path)).toString());
const reports = await Promise.all(process.argv.slice(2).map(read));
if (!reports.length) {
	throw new Error("Supply compressed recruitment evidence");
}
const weight = (index: number, pos: string) =>
	index < starters[pos]!
		? 1
		: 0.18 ** (index - starters[pos]! + 1) * (index >= targets[pos]! ? 0.1 : 1);
const total = (scores: number[], pos: string) =>
	scores.reduce((sum, n, i) => sum + n * weight(i, pos), 0);
const priority = (p: Prospect, d: Decision, v: Variant) => {
	const pos = p.pos,
		score = p.score.score!;
	const incumbents = d.roster
		.filter((q) => q.pos === pos)
		.map((q) => ({
			...q,
			value: Math.max(
				0,
				Math.min(
					100,
					q.score.score! - (v.noPerformance ? q.score.performance! : 0),
				),
			),
		}))
		.sort((a, b) => b.value - a.value);
	const before = incumbents.map((q) => q.value),
		after = [...before, score].sort((a, b) => b - a);
	const rank = before.filter((n) => n >= score).length;
	const lastStarter = incumbents[starters[pos]! - 1];
	let opportunity = weight(rank, pos);
	const games = d.record.reduce((a, b) => a + b, 0),
		winp = games ? (d.record[0]! + 0.5 * d.record[2]!) / games : 0.5;
	const rebuild =
		games >= 4 && winp >= 0.65
			? 0.15
			: games >= Math.max(4, 17 * 0.3) && winp < 0.35
				? 1
				: d.strategy === "rebuilding"
					? 0.75
					: 0;
	// Older evidence omits candidate birth years. Infer only the <=24 condition
	// from the stored age/potential term; tolerate its three-decimal rounding.
	const youth =
		p.score.future! /
		(2 +
			Math.min(25, Math.max(0, p.score.potential! - p.score.ability!)) *
				(0.1 + 0.25 * rebuild));
	if (
		pos === "QB" &&
		rank === 1 &&
		lastStarter &&
		lastStarter.age >= 31 &&
		youth >= 0.599 &&
		!incumbents.slice(1).some((q) => q.age <= 25 && q.value >= score - 5)
	) {
		opportunity = Math.max(
			opportunity,
			Math.min(0.8, 0.5 + (lastStarter.age - 31) * 0.1),
		);
	}
	if (
		v.smooth &&
		pos !== "QB" &&
		pos !== "K" &&
		pos !== "P" &&
		rank >= starters[pos]! &&
		lastStarter
	) {
		const gap = Math.max(0, lastStarter.value - score);
		// A close contender can earn a role during a multi-year rookie contract.
		// Several comparable reserves still make another acquisition redundant.
		const blockers = Math.max(0, rank - starters[pos]!);
		opportunity = Math.max(
			opportunity,
			Math.exp(-gap / 8) * 0.5 ** blockers * (rank >= targets[pos]! ? 0.1 : 1),
		);
	}
	const curve = Math.max(0, score - 30) ** 2 / 80;
	const premium = opportunity > 0.18 ? curve : Math.min(curve, score * 0.2);
	return (
		(v.weights ?? oldWeights)[pos]! *
		(total(after, pos) - total(before, pos) + premium * opportunity) *
		(pos === "K" ? 0.25 : pos === "P" ? 0.15 : 1)
	);
};
const counts = () =>
	Object.fromEntries(Object.keys(starters).map((pos) => [pos, 0]));
const results = variants.map((v) => ({
	name: v.name,
	best: counts(),
	expected: counts(),
	changed: 0,
}));
const examples: unknown[] = [];
let maxReconstructionError = 0;
const incumbentRows: Record<string, Incumbent[]> = {};
for (const r of reports) {
	for (const d of r.draftDecisions) {
		for (const [pos, n] of Object.entries(starters)) {
			const group = d.roster
				.filter((p) => p.pos === pos)
				.sort((a, b) => b.score.score! - a.score.score!)
				.slice(0, n);
			(incumbentRows[pos] ??= []).push(...group);
		}
		const original = d.candidates.toSorted(
			(a, b) => b.fit.draftValue - a.fit.draftValue,
		)[0]!;
		for (const [i, v] of variants.entries()) {
			const priorities = d.candidates
				.map((p) => ({ p, value: priority(p, d, v) }))
				.sort((a, b) => b.value - a.value);
			const best = priorities[0]!;
			results[i]!.best[best.p.pos] = results[i]!.best[best.p.pos]! + 1;
			results[i]!.changed += best.p.pid !== original.pid ? 1 : 0;
			const sum = priorities.reduce(
				(s, p) =>
					s + (Math.max(0.01, p.value) / Math.max(0.01, best.value)) ** 40,
				0,
			);
			for (const p of priorities) {
				results[i]!.expected[p.p.pos] =
					results[i]!.expected[p.p.pos]! +
					(Math.max(0.01, p.value) / Math.max(0.01, best.value)) ** 40 / sum;
			}
			if (i === 0) {
				for (const p of priorities) {
					maxReconstructionError = Math.max(
						maxReconstructionError,
						Math.abs(p.value - p.p.fit.draftValue),
					);
				}
			}
			if (
				v.name === "weights and competition" &&
				best.p.pos === "WR" &&
				original.pos !== "WR"
			) {
				examples.push({
					seed: r.seed,
					season: d.season,
					tid: d.tid,
					pick: d.pick,
					previous: original,
					alternative: best.p,
					priority: best.value,
					wrIncumbents: d.roster.filter((p) => p.pos === "WR"),
				});
			}
		}
	}
}
if (maxReconstructionError > 0.01) {
	throw new Error(
		`Shadow baseline differs from recorded priority: ${maxReconstructionError}`,
	);
}
const mean = (ns: number[]) => ns.reduce((a, b) => a + b, 0) / ns.length;
const incumbentSummary = Object.fromEntries(
	Object.entries(incumbentRows).map(([pos, ps]) => [
		pos,
		{
			ability: mean(ps.map((p) => p.score.ability!)),
			performance: mean(ps.map((p) => p.score.performance!)),
			score: mean(ps.map((p) => p.score.score!)),
		},
	]),
);
const output = {
	method:
		"Fixed saved decisions. Each variation evaluates the same candidate pool and roster; this is not a sequential draft or a league simulation. Expected selections use the production exponent 40. Removing incumbent performance is a sensitivity test, not a proposed change to the player scorer.",
	maxReconstructionError,
	incumbentSummary,
	results,
	examples,
};
await fs.writeFile(
	"analysis/starter-score/league-draft-bias-diagnosis.json.gz",
	gzipSync(JSON.stringify(output)),
);
console.log(
	JSON.stringify(
		{ maxReconstructionError, incumbentSummary, results },
		null,
		2,
	),
);
