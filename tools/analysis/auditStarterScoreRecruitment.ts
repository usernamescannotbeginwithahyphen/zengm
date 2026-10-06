import fs from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";

type Score = Record<string, number> & {
	score: number;
	ability: number;
	potential: number;
	runway: number;
	future: number;
	continuity: number;
};
type Prospect = {
	pid: number;
	pos: string;
	ovr: number;
	pot: number;
	marketValue: number;
	score: Score;
	fit: { draftValue: number; value: number; starterGain: number };
};
type RosterPlayer = { pid: number; pos: string; age: number; score: Score };
type Decision = {
	season: number;
	tid: number;
	pick: number;
	pid: number;
	strategy: string;
	record: number[];
	candidates: Prospect[];
	roster: RosterPlayer[];
};
type QB = RosterPlayer & {
	ovr: number;
	pot: number;
	draft: { round: number; year: number };
	contract: { amount: number };
	stats: Record<string, number>;
};
type Report = {
	seed: number;
	years: number;
	gameCount: number;
	games: {
		season: number;
		tid: number;
		playoffs: boolean;
		starter: number;
		unavailable: number[];
		qbs: { pid: number; unavailable: boolean }[];
	}[];
	players: {
		pid: number;
		draft: { year: number; tid: number; round: number };
		ratings: { season: number; pos: string }[];
	}[];
	awards: {
		season: number;
		awards: { actAs?: string; winner?: { pid: number }[] }[];
	}[];
	draftDecisions: Decision[];
	checkpoints: {
		season: number;
		label: string;
		teams: {
			tid: number;
			name: string;
			depth: Record<string, number[]>;
			qbs: QB[];
		}[];
	}[];
};

const output =
	process.env.STARTER_SCORE_RECRUITMENT_PREFIX ?? "league-recruitment-before";
const read = async (file: string): Promise<Report> => {
	const bytes = await fs.readFile(file);
	return JSON.parse(
		(file.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString(),
	);
};
const reports = await Promise.all(process.argv.slice(2).map(read));
if (!reports.length) {
	throw new Error(
		"Supply generated league reports with recruitment observations",
	);
}
if (process.env.STARTER_SCORE_PACK_RECRUITMENT) {
	for (const [index, r] of reports.entries()) {
		const file = process.argv.slice(2)[index]!;
		if (file.endsWith(".gz")) {
			continue;
		}
		// Keep the complete candidate universe and roster checkpoints. Compact
		// unrelated box-score fields; this evidence feeds this audit, not the
		// earlier all-position weekly-performance report.
		const packed = {
			seed: r.seed,
			years: r.years,
			gameCount: r.gameCount,
			scope:
				"Recruitment decisions, roster checkpoints, actual QB starts, draft records and awards. Full box scores remain in the local expanded run.",
			draftDecisions: r.draftDecisions,
			checkpoints: r.checkpoints,
			awards: r.awards,
			games: r.games.map((g) => ({
				season: g.season,
				tid: g.tid,
				playoffs: g.playoffs,
				starter: g.starter,
				unavailable: g.unavailable,
				qbs: g.qbs.map((p) => ({ pid: p.pid, unavailable: p.unavailable })),
			})),
			players: r.players.map((p) => ({
				pid: p.pid,
				draft: p.draft,
				ratings: p.ratings,
			})),
		};
		await fs.writeFile(`${file}.gz`, gzipSync(JSON.stringify(packed)));
	}
}
const counts = (rows: { pos: string }[]) =>
	Object.fromEntries(
		["QB", "RB", "WR", "TE", "OL", "DL", "LB", "CB", "S", "K", "P"].map(
			(pos) => [pos, rows.filter((p) => p.pos === pos).length],
		),
	);
const decisions = reports.flatMap((r) =>
	r.draftDecisions.map((d) => {
		const chosen = d.candidates.find((p) => p.pid === d.pid)!;
		if (!chosen) {
			throw new Error(`Missing selection ${d.pid}`);
		}
		const bestAbility = d.candidates.toSorted(
			(a, b) => b.score.ability - a.score.ability,
		)[0]!;
		const bestMarket = d.candidates.toSorted(
			(a, b) => b.marketValue - a.marketValue,
		)[0]!;
		const alternatives = Object.values(
			Object.groupBy(d.candidates, (p) => p.pos),
		).map((ps) => ps![0]!);
		const higherWR = d.candidates
			.filter(
				(p) => p.pos === "WR" && p.score.ability >= chosen.score.ability + 15,
			)
			.sort((a, b) => b.fit.draftValue - a.fit.draftValue)[0];
		const underfilled = (p: Prospect) => {
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
			const ranked = d.roster
				.filter((q) => q.pos === p.pos)
				.sort((a, b) => b.score.score - a.score.score);
			return {
				rank: 1 + ranked.filter((q) => q.score.score >= p.score.score).length,
				weakestStarter: ranked[starters[p.pos]! - 1],
				incumbents: ranked,
			};
		};
		return {
			seed: r.seed,
			season: d.season,
			tid: d.tid,
			team: r.checkpoints[0]!.teams.find((t) => t.tid === d.tid)!.name,
			pick: d.pick,
			strategy: d.strategy,
			record: d.record,
			chosen,
			chosenRole: underfilled(chosen),
			bestAbility,
			bestMarket,
			alternatives,
			higherWR: higherWR
				? { player: higherWR, role: underfilled(higherWR) }
				: undefined,
			abilityGap: bestAbility.score.ability - chosen.score.ability,
			scoreGap:
				Math.max(...d.candidates.map((p) => p.score.score)) -
				chosen.score.score,
		};
	}),
);
const supply = reports.flatMap((r) =>
	r.draftDecisions
		.filter((d) => d.pick === 1)
		.map((d) => ({
			seed: r.seed,
			season: d.season,
			all: counts(d.candidates),
			top32Ability: counts(
				d.candidates
					.toSorted((a, b) => b.score.ability - a.score.ability)
					.slice(0, 32),
			),
			top32Market: counts(
				d.candidates
					.toSorted((a, b) => b.marketValue - a.marketValue)
					.slice(0, 32),
			),
			top32Potential: counts(
				d.candidates
					.toSorted((a, b) => b.score.potential - a.score.potential)
					.slice(0, 32),
			),
		})),
);
const rookieQBs = reports.flatMap((r) =>
	r.draftDecisions
		.filter((d) => d.candidates.find((p) => p.pid === d.pid)?.pos === "QB")
		.map((d) => {
			const opening = r.checkpoints
				.find(
					(c) =>
						c.season === d.season + 1 &&
						(c.label === "opening" || c.label === "final-opening"),
				)!
				.teams.find((t) => t.tid === d.tid)!;
			const rookie = opening.qbs.find((p) => p.pid === d.pid)!;
			const rivals = opening.qbs.filter((p) => p.pid !== d.pid);
			const best = rivals.toSorted((a, b) => b.score.score - a.score.score)[0];
			const firstGame = r.games.find(
				(g) => !g.playoffs && g.season === d.season + 1 && g.tid === d.tid,
			);
			const decision = decisions.find(
				(row) =>
					row.seed === r.seed && row.season === d.season && row.pick === d.pick,
			)!;
			return {
				seed: r.seed,
				season: d.season,
				team: opening.name,
				pick: d.pick,
				rookie,
				best,
				starter: opening.depth.QB?.[0] === d.pid,
				actualOpenerStart: firstGame ? firstGame.starter === d.pid : null,
				unavailableInOpener:
					firstGame?.qbs.find((p) => p.pid === d.pid)?.unavailable ?? null,
				abilityLead:
					rookie.score.ability -
					Math.max(0, ...rivals.map((p) => p.score.ability)),
				noRunwayLead:
					rookie.score.score -
					rookie.score.runway -
					Math.max(0, ...rivals.map((p) => p.score.score - p.score.runway)),
				noDevelopmentLead:
					rookie.score.score -
					rookie.score.runway -
					rookie.score.future -
					rookie.score.continuity -
					Math.max(
						0,
						...rivals.map(
							(p) =>
								p.score.score -
								p.score.runway -
								p.score.future -
								p.score.continuity,
						),
					),
				draftRank: decision.chosenRole.rank,
				draftAbility: decision.chosen.score.ability,
			};
		}),
);
const aggregate = {
	drafts: supply.length,
	picks: decisions.length,
	positions: counts(decisions.map((d) => d.chosen)),
	supplyTop32Ability: counts(
		supply.flatMap((s) =>
			Object.entries(s.top32Ability).flatMap(([pos, n]) =>
				Array.from({ length: n }, () => ({ pos })),
			),
		),
	),
	supplyTop32Market: counts(
		supply.flatMap((s) =>
			Object.entries(s.top32Market).flatMap(([pos, n]) =>
				Array.from({ length: n }, () => ({ pos })),
			),
		),
	),
	supplyTop32Potential: counts(
		supply.flatMap((s) =>
			Object.entries(s.top32Potential).flatMap(([pos, n]) =>
				Array.from({ length: n }, () => ({ pos })),
			),
		),
	),
	abilityGap15: decisions.filter((d) => d.abilityGap >= 15).length,
	OLPassingWR15: decisions.filter((d) => d.chosen.pos === "OL" && d.higherWR)
		.length,
	OLPassingWR15WithHigherStarterGain: decisions.filter(
		(d) =>
			d.chosen.pos === "OL" &&
			d.higherWR &&
			d.higherWR.player.fit.starterGain > d.chosen.fit.starterGain,
	).length,
	rookieQBs: rookieQBs.length,
	rookieStarters: rookieQBs.filter((q) => q.starter).length,
	rookieAbilityLeaders: rookieQBs.filter((q) => q.abilityLead > 0).length,
	startersWithoutRunway: rookieQBs.filter((q) => q.noRunwayLead > 0).length,
	startersWithoutDevelopmentOrContinuity: rookieQBs.filter(
		(q) => q.noDevelopmentLead > 0,
	).length,
	draftedBackupQBs: rookieQBs.filter((q) => q.draftRank > 1).length,
	observedRookieOpeners: rookieQBs.filter((q) => q.actualOpenerStart !== null)
		.length,
	actualRookieOpenerStarts: rookieQBs.filter(
		(q) => q.actualOpenerStart === true,
	).length,
	healthyRookiesBenchedInOpener: rookieQBs.filter(
		(q) => q.actualOpenerStart === false && q.unavailableInOpener === false,
	).length,
};
const safety = {
	games: 0,
	healthyQBChanges: 0,
	immediateHealthyReversals: 0,
	multipleQBDrafts: 0,
	productiveIncumbentFlags: 0,
	mvps: 0,
	mvpsStillStarting: 0,
};
const multipleQBDrafts: { seed: number; key: string; pids: number[] }[] = [];
for (const r of reports) {
	safety.games += r.gameCount;
	const histories = Object.groupBy(
		r.games.filter((g) => !g.playoffs),
		(g) => `${g.season}/${g.tid}`,
	);
	for (const history of Object.values(histories)) {
		const games = history!;
		for (let i = 1; i < games.length; i++) {
			const before = games[i - 1]!,
				after = games[i]!;
			if (before.starter === after.starter) {
				continue;
			}
			const outgoing = after.qbs.find((p) => p.pid === before.starter),
				incoming = after.qbs.find((p) => p.pid === after.starter),
				oldIncoming = before.qbs.find((p) => p.pid === after.starter);
			if (
				!outgoing ||
				!incoming ||
				!oldIncoming ||
				outgoing.unavailable ||
				incoming.unavailable ||
				oldIncoming.unavailable ||
				before.unavailable.includes(before.starter)
			) {
				continue;
			}
			safety.healthyQBChanges++;
			if (
				i >= 2 &&
				games[i - 2]!.starter === after.starter &&
				!games[i - 2]!.unavailable.includes(before.starter)
			) {
				safety.immediateHealthyReversals++;
			}
		}
	}
	const qbs = r.players.filter(
		(p) =>
			p.draft.year >= 2026 &&
			p.draft.year < 2026 + r.years &&
			p.draft.round > 0 &&
			(p.ratings.find((row) => row.season === p.draft.year) ?? p.ratings[0])
				?.pos === "QB",
	);
	for (const [key, ps] of Object.entries(
		Object.groupBy(qbs, (p) => `${p.draft.year}/${p.draft.tid}`),
	)) {
		if (ps!.length > 1) {
			multipleQBDrafts.push({ seed: r.seed, key, pids: ps!.map((p) => p.pid) });
		}
	}
	for (const d of r.draftDecisions.filter(
		(d) => d.candidates.find((p) => p.pid === d.pid)?.pos === "QB",
	)) {
		const prior = r.checkpoints
			.find((c) => c.label === "season-end" && c.season === d.season)!
			.teams.find((t) => t.tid === d.tid)!;
		if (
			prior.qbs.some((q) => q.stats.pss! >= 200 && q.score.performance! >= 3)
		) {
			safety.productiveIncumbentFlags++;
		}
	}
	for (const award of r.awards) {
		const mvp = award.awards.find((a) => a.actAs === "mvp")?.winner?.[0];
		if (!mvp) {
			continue;
		}
		safety.mvps++;
		const p = r.players.find((p) => p.pid === mvp.pid)!;
		const pos =
			p.ratings.find((row) => row.season === award.season)?.pos ?? "QB";
		const next = r.checkpoints.find(
			(c) =>
				c.season === award.season + 1 &&
				(c.label === "opening" || c.label === "final-opening"),
		);
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
		if (
			next?.teams.some((t) =>
				t.depth[pos]?.slice(0, starters[pos]).includes(p.pid),
			)
		) {
			safety.mvpsStillStarting++;
		}
	}
}
safety.multipleQBDrafts = multipleQBDrafts.length;
const report = {
	aggregate,
	safety,
	multipleQBDrafts,
	supply,
	rookieQBs,
	decisions,
};
await fs.writeFile(
	`analysis/starter-score/${output}-audit.json`,
	JSON.stringify(report, null, 2),
);
await fs.writeFile(
	`analysis/starter-score/${output}-audit.json.gz`,
	gzipSync(JSON.stringify(report)),
);
const esc = (v: unknown) =>
	String(v ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll('"', "&quot;");
const table = (heads: string[], rows: unknown[][]) =>
	`<div class="table"><table><thead><tr>${heads.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((v) => `<td>${esc(typeof v === "number" ? Math.round(v * 100) / 100 : v)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
// The supplied reference combines OT + IOL as OL, and EDGE + DT as DL. It is an
// approximate comparison, not a verified dataset or a quota for the simulator.
const reference: Record<string, number> = {
	QB: 9.1,
	RB: 7,
	WR: 12,
	TE: 3.5,
	OL: 17.2,
	DL: 26.1,
	LB: 6.6,
	CB: 11.9,
	S: 6.6,
};
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Starter Score recruitment audit</title><style>body{font:16px/1.55 system-ui;background:#f3f5f8;color:#172438;margin:0}main{max-width:1200px;margin:auto;padding:32px}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;font-size:14px}th,td{padding:9px;border-bottom:1px solid #cbd2da;text-align:left}th{background:#e3eaf3}.table{overflow:auto}details{margin:15px 0;padding:12px;background:white;border:1px solid #d4dce5}summary{cursor:pointer;font-weight:650}p{max-width:95ch}pre{overflow:auto;font-size:13px}h2{margin-top:34px}</style></head><body><main><h1>What did each team pass over?</h1><p>${supply.length} complete drafts in ${reports.length} generated leagues. Every first-round choice records the entire available class before selection. The observer delegates to the production draft. Supply rankings are diagnostic controls, not alternate drafts or a measure of objective player quality.</p><h2>Position spread and prospect supply</h2>${table(
	[
		"Role",
		"Selected",
		"Selected %",
		"User reference %",
		"Top 32 ability/class",
		"Top 32 market/class",
		"Top 32 potential/class",
	],
	Object.entries(aggregate.positions).map(([pos, n]) => [
		pos,
		n,
		(100 * n) / decisions.length,
		reference[pos] ?? "—",
		aggregate.supplyTop32Ability[pos],
		aggregate.supplyTop32Market[pos],
		aggregate.supplyTop32Potential[pos],
	]),
)}<p>The user-supplied reference is approximate and unverified. OL combines tackles, guards and centers; DL combines edge and interior, although game role definitions do not map perfectly. No quotas were applied.</p><h2>First-round QB opening decisions</h2><p>Removing components from saved scores is a sensitivity check, not a replay: development, acquisitions and earlier depth decisions remain fixed. “No development” removes runway, future and continuity from every QB.</p>${table(
	[
		"Team / draft",
		"Pick",
		"Preseason depth leader",
		"Actual opener start",
		"Unavailable in opener",
		"Draft role rank",
		"Draft ability",
		"Opening ability lead",
		"Lead without runway",
		"Lead without development",
	],
	rookieQBs.map((q) => [
		`${q.team} ${q.season} (${q.seed})`,
		q.pick,
		q.starter,
		q.actualOpenerStart ?? "Not simulated",
		q.unavailableInOpener ?? "Not simulated",
		q.draftRank,
		q.draftAbility,
		q.abilityLead,
		q.noRunwayLead,
		q.noDevelopmentLead,
	]),
)}<h2>OL choices with a WR at least 15 ability points stronger</h2><p>${aggregate.OLPassingWR15} flags, of which ${aggregate.OLPassingWR15WithHigherStarterGain} also offered a larger immediate starting-score upgrade at WR. Fifteen is an inspection threshold supplied by the discussion, not a rule in the AI.</p>${decisions
	.filter((d) => d.chosen.pos === "OL" && d.higherWR)
	.map(
		(d) =>
			`<details><summary>${esc(d.team)} ${d.season}, pick ${d.pick}, seed ${d.seed}</summary>${table(
				[
					"Candidate",
					"Ability",
					"Potential",
					"Starter Score",
					"Draft priority",
					"Starting upgrade",
					"Role rank",
				],
				[
					[
						`Chosen OL #${d.chosen.pid}`,
						d.chosen.score.ability,
						d.chosen.score.potential,
						d.chosen.score.score,
						d.chosen.fit.draftValue,
						d.chosen.fit.starterGain,
						d.chosenRole.rank,
					],
					[
						`Available WR #${d.higherWR!.player.pid}`,
						d.higherWR!.player.score.ability,
						d.higherWR!.player.score.potential,
						d.higherWR!.player.score.score,
						d.higherWR!.player.fit.draftValue,
						d.higherWR!.player.fit.starterGain,
						d.higherWR!.role.rank,
					],
				],
			)}<p>Existing OL scores: ${d.chosenRole.incumbents.map((p) => p.score.score.toFixed(1)).join(", ")}. Existing WR scores: ${d.higherWR!.role.incumbents.map((p) => p.score.score.toFixed(1)).join(", ")}.</p></details>`,
	)
	.join(
		"",
	)}<h2>Every first-round decision</h2><p>Best available candidate by draft priority at each position. Expand to compare need, talent, and the actual selection.</p>${decisions
	.map(
		(d) =>
			`<details><summary>${esc(d.team)} ${d.season}, pick ${d.pick}: ${d.chosen.pos} #${d.chosen.pid} (${d.seed})</summary>${table(
				[
					"Role",
					"Player",
					"Ability",
					"Potential",
					"Starter Score",
					"Draft priority",
					"Starting upgrade",
				],
				d.alternatives.map((p) => [
					p.pos,
					p.pid,
					p.score.ability,
					p.score.potential,
					p.score.score,
					p.fit.draftValue,
					p.fit.starterGain,
				]),
			)}</details>`,
	)
	.join("")}</main></body></html>`;
await fs.writeFile(`analysis/starter-score/${output}-audit.html`, html);
console.log(JSON.stringify({ aggregate, safety }, null, 2));
