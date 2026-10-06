import fs from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";

type Prospect = {
	pid: number;
	pos: string;
	score: Record<string, number>;
	fit: { draftValue: number; starterGain: number };
};
type Decision = {
	season: number;
	tid: number;
	pick: number;
	pid: number;
	candidates: Prospect[];
};
type Report = { seed: number; draftDecisions: Decision[] };
const baseline: Record<string, number> = {
	QB: 0.14,
	RB: 0.065,
	WR: 0.095,
	TE: 0.05,
	OL: 0.075,
	DL: 0.1,
	LB: 0.07,
	CB: 0.065,
	S: 0.065,
	K: 0.035,
	P: 0.025,
};
// A small, declared sensitivity experiment. No search for reference percentages.
const variants = [
	{ name: "Current", weights: baseline },
	{ name: "DL only", weights: { ...baseline, DL: 0.115 } },
	{ name: "OL and CB only", weights: { ...baseline, OL: 0.07, CB: 0.06 } },
	{ name: "Safety only", weights: { ...baseline, S: 0.055 } },
	{
		name: "Combined",
		weights: { ...baseline, DL: 0.115, CB: 0.06, S: 0.055 },
	},
	{
		name: "Conservative trial",
		weights: { ...baseline, DL: 0.105, S: 0.055 },
	},
];
const reports: Report[] = await Promise.all(
	process.argv
		.slice(2)
		.map(async (p) => JSON.parse(gunzipSync(await fs.readFile(p)).toString())),
);
if (!reports.length) {
	throw new Error(
		"Supply compressed recruitment reports from revision 5f8b9151d",
	);
}
const counts = () =>
	Object.fromEntries(Object.keys(baseline).map((p) => [p, 0]));
const results = variants.map((v) => ({
	name: v.name,
	weights: v.weights,
	expected: counts(),
	changedBest: 0,
}));
const changes: unknown[] = [];
for (const r of reports) {
	for (const d of r.draftDecisions) {
		const original = d.candidates.toSorted(
			(a, b) => b.fit.draftValue - a.fit.draftValue,
		)[0]!;
		for (const [i, v] of variants.entries()) {
			// Production priority is linear in its primary-position weight;
			// all player scores, roster opportunities and talent terms stay fixed.
			const ranked = d.candidates
				.map((p) => ({
					p,
					value: (p.fit.draftValue * v.weights[p.pos]!) / baseline[p.pos]!,
				}))
				.sort((a, b) => b.value - a.value);
			const best = ranked[0]!;
			const probabilities = ranked.map(
				(p) => (Math.max(0.01, p.value) / Math.max(0.01, best.value)) ** 40,
			);
			const total = probabilities.reduce((a, b) => a + b, 0);
			for (const [j, p] of ranked.entries()) {
				results[i]!.expected[p.p.pos] =
					results[i]!.expected[p.p.pos]! + probabilities[j]! / total;
			}
			if (best.p.pid !== original.pid) {
				results[i]!.changedBest++;
				if (v.name === "Combined") {
					changes.push({
						seed: r.seed,
						season: d.season,
						tid: d.tid,
						pick: d.pick,
						previous: original,
						revised: best.p,
						priority: best.value,
					});
				}
			}
		}
	}
}
const output = {
	method:
		"Fixed-input sensitivity check on saved pre-pick pools. Probabilities use exponent 40. These are not sequential drafts: prospects remain in later saved pools even if a variant would take them earlier. Ratios change only positional weights; source priorities are rounded to three decimals.",
	baselineRevision: "5f8b9151d",
	decisions: reports.reduce((n, r) => n + r.draftDecisions.length, 0),
	results,
	changes,
};
await fs.writeFile(
	"analysis/starter-score/league-position-weight-sensitivity.json.gz",
	gzipSync(JSON.stringify(output)),
);
console.log(JSON.stringify({ decisions: output.decisions, results }, null, 2));
