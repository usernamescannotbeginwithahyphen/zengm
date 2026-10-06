import fs from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

type QB = {
	pid: number;
	name: string;
	age: number;
	ovr: number;
	pot: number;
	unavailable?: boolean;
	contract: { amount: number; exp: number };
	draft: { year: number; round: number; pick: number; tid: number };
	score: { score: number; performance: number; continuity: number };
	stats: Record<string, number>;
	previousStats: Record<string, number>;
};
type Team = {
	tid: number;
	name: string;
	strategy: string;
	record: number[];
	depth: Record<string, number[]>;
	qbs: QB[];
	rosterCounts: Record<string, number>;
};
type Game = {
	season: number;
	playoffs: boolean;
	gid: number;
	day: number;
	tid: number;
	record: number[];
	strategy: string;
	starter: number;
	depthQB: number[];
	qbs: QB[];
	roles: Record<string, { pid: number; unavailable: boolean }[]>;
	unavailable: number[];
	points: number;
	qbGameStats: ({ pid: number } & Record<string, number>)[];
};
type Player = {
	pid: number;
	name: string;
	tid: number;
	draft: QB["draft"];
	ratings: { season: number; pos: string; ovr: number; pot: number }[];
	stats: ({ season: number; tid: number; playoffs: boolean } & Record<
		string,
		number
	>)[];
	transactions?: {
		season: number;
		phase: number;
		type: string;
		tid: number;
		fromTid?: number;
	}[];
};
type Report = {
	seed: number;
	years: number;
	fieldLength: number;
	methodology: string;
	gameCount: number;
	games: Game[];
	checkpoints: {
		label: string;
		season: number;
		phase: number;
		teams: Team[];
	}[];
	players: Player[];
	awards: {
		season: number;
		awards: { actAs?: string; winner?: { pid: number; tid: number }[] }[];
	}[];
};
const directory = path.resolve("analysis/starter-score");
const files = process.argv.slice(2);
if (files.length === 0) {
	throw new Error("Pass league report JSON paths");
}
const reports: Report[] = await Promise.all(
	files.map(async (file) => {
		const bytes = await fs.readFile(file);
		return JSON.parse(
			(file.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8"),
		) as Report;
	}),
);
const playerLabel = (p: { pid: number; name: string }) =>
	`${p.name === "FirstName LastName" ? "Player" : p.name} #${p.pid}`;
const teamRows: {
	seed: number;
	season: number;
	tid: number;
	name: string;
	record: number[];
	starts: number[];
	depth: number[];
	startChanges: number;
	healthyChanges: number;
	injuryChanges: number;
	transactionChanges: number;
	depthChanges: number;
	rapidReversals: number;
	changes: unknown[];
}[] = [];
const roles: Record<
	string,
	{
		slots: number;
		comparisons: number;
		changedSlots: number;
		healthyChangedSlots: number;
	}
> = {};
const acquisitions = [];
const mvpRows = [];
const firstRound: {
	seed: number;
	season: number;
	pos: string;
	pid: number;
	name: string;
	tid: number;
	pick: number;
}[] = [];
const histories: {
	seed: number;
	name: string;
	season: number;
	tid: number;
	games: Game[];
}[] = [];
for (const report of reports) {
	const names = new Map(
		report.checkpoints[0]!.teams.map((t) => [t.tid, t.name]),
	);
	const groups = new Map<string, Game[]>();
	for (const game of report.games.filter((g) => !g.playoffs)) {
		const key = `${game.season}:${game.tid}`;
		if (!groups.has(key)) {
			groups.set(key, []);
		}
		groups.get(key)!.push(game);
	}
	for (const games of groups.values()) {
		games.sort((a, b) => a.day - b.day || a.gid - b.gid);
		const first = games[0]!;
		const changes = [];
		let startChanges = 0,
			healthyChanges = 0,
			injuryChanges = 0,
			transactionChanges = 0,
			depthChanges = 0,
			rapidReversals = 0;
		for (let i = 1; i < games.length; i++) {
			const before = games[i - 1]!,
				after = games[i]!;
			if (before.depthQB[0] !== after.depthQB[0]) {
				depthChanges++;
			}
			if (before.starter !== after.starter) {
				startChanges++;
				const outgoing = after.qbs.find((p) => p.pid === before.starter),
					incoming = after.qbs.find((p) => p.pid === after.starter);
				const oldIncoming = before.qbs.find((p) => p.pid === after.starter);
				const kind =
					!outgoing || !oldIncoming
						? "roster change"
						: outgoing.unavailable ||
							  incoming?.unavailable ||
							  oldIncoming.unavailable ||
							  before.unavailable.includes(before.starter)
							? "injury-associated"
							: "healthy competition";
				if (kind === "healthy competition") {
					healthyChanges++;
				} else if (kind === "injury-associated") {
					injuryChanges++;
				} else {
					transactionChanges++;
				}
				changes.push({
					game: i + 1,
					kind,
					record: after.record,
					from: outgoing ?? before.qbs.find((p) => p.pid === before.starter),
					to: incoming,
				});
				if (
					kind === "healthy competition" &&
					i >= 2 &&
					games[i - 2]!.starter === after.starter &&
					!games[i - 2]!.unavailable.includes(before.starter)
				) {
					rapidReversals++;
				}
			}
			for (const [pos, group] of Object.entries(after.roles)) {
				const previous = before.roles[pos]!;
				const added = group.filter(
					(p) => !previous.some((other) => other.pid === p.pid),
				);
				const removed = previous.filter(
					(p) => !group.some((other) => other.pid === p.pid),
				);
				roles[pos] ??= {
					slots: group.length,
					comparisons: 0,
					changedSlots: 0,
					healthyChangedSlots: 0,
				};
				roles[pos]!.comparisons += group.length;
				roles[pos]!.changedSlots += added.length;
				if (
					[...added, ...removed].every(
						(p) =>
							!after.unavailable.includes(p.pid) &&
							!before.unavailable.includes(p.pid),
					)
				) {
					roles[pos]!.healthyChangedSlots += added.length;
				}
			}
		}
		const seasonEnd = report.checkpoints
			.find((c) => c.label === "season-end" && c.season === first.season)!
			.teams.find((t) => t.tid === first.tid)!;
		teamRows.push({
			seed: report.seed,
			season: first.season,
			tid: first.tid,
			name: names.get(first.tid)!,
			record: seasonEnd.record,
			starts: games.map((g) => g.starter),
			depth: games.map((g) => g.depthQB[0]!),
			startChanges,
			healthyChanges,
			injuryChanges,
			transactionChanges,
			depthChanges,
			rapidReversals,
			changes,
		});
		histories.push({
			seed: report.seed,
			name: names.get(first.tid)!,
			season: first.season,
			tid: first.tid,
			games,
		});
	}
	for (const player of report.players) {
		if (
			player.draft.year < 2026 ||
			player.draft.year >= 2026 + report.years ||
			player.draft.round !== 1
		) {
			continue;
		}
		const rating =
			player.ratings.find((r) => r.season === player.draft.year) ??
			player.ratings[0]!;
		firstRound.push({
			seed: report.seed,
			season: player.draft.year,
			pos: rating.pos,
			pid: player.pid,
			name: playerLabel(player),
			tid: player.draft.tid,
			pick: player.draft.pick,
		});
		if (rating.pos !== "QB") {
			continue;
		}
		const prior = report.checkpoints
			.find((c) => c.label === "season-end" && c.season === player.draft.year)!
			.teams.find((t) => t.tid === player.draft.tid)!;
		const opening = report.checkpoints
			.find(
				(c) =>
					(c.label === "opening" || c.label === "final-opening") &&
					c.season === player.draft.year + 1,
			)!
			.teams.find((t) => t.tid === player.draft.tid)!;
		const addedVeterans = opening.qbs.filter(
			(q) => q.pid !== player.pid && !prior.qbs.some((p) => p.pid === q.pid),
		);
		const subsequentSignings = report.players
			.filter(
				(p) =>
					p.pid !== player.pid &&
					p.ratings.some(
						(r) => r.season === player.draft.year && r.pos === "QB",
					) &&
					p.transactions?.some(
						(tx) =>
							tx.type === "freeAgent" &&
							tx.tid === player.draft.tid &&
							((tx.season === player.draft.year && tx.phase > 5) ||
								(tx.season === player.draft.year + 1 && tx.phase < 1)),
					),
			)
			.map((p) => ({
				pid: p.pid,
				name: playerLabel(p),
				retained: opening.qbs.some((q) => q.pid === p.pid),
			}));
		acquisitions.push({
			seed: report.seed,
			season: player.draft.year,
			team: prior.name,
			record: prior.record,
			rookie: playerLabel(player),
			pick: player.draft.pick,
			priorQBs: prior.qbs,
			openingQBs: opening.qbs,
			openingLeader: opening.depth.QB![0],
			addedVeterans,
			subsequentSignings,
			productiveIncumbent: prior.qbs.some(
				(q) => q.stats.pss! >= 200 && q.score.performance >= 3,
			),
		});
	}
	for (const award of report.awards) {
		const mvp = award.awards.find((a) => a.actAs === "mvp")?.winner?.[0];
		if (!mvp) {
			continue;
		}
		const next = report.checkpoints.find(
			(c) =>
				(c.label === "opening" || c.label === "final-opening") &&
				c.season === award.season + 1,
		);
		const player = report.players.find((p) => p.pid === mvp.pid)!;
		const pos = player.ratings.find((r) => r.season === award.season)?.pos;
		const team = next?.teams.find((t) =>
			t.depth[pos ?? "QB"]?.includes(player.pid),
		);
		// Every depth list includes the whole roster, so use QB roster membership
		// or any role's membership only to locate the team, then inspect native rank.
		const rank = team?.depth[pos ?? "QB"]?.indexOf(player.pid);
		mvpRows.push({
			seed: report.seed,
			season: award.season,
			name: playerLabel(player),
			pos,
			nextTeam: team?.name,
			rank: rank === undefined ? null : rank + 1,
			stillStarting:
				rank !== undefined &&
				rank >= 0 &&
				rank < (roles[pos ?? "QB"]?.slots ?? 1),
			qbs: team?.qbs,
		});
	}
}
const sum = (
	key:
		| "startChanges"
		| "healthyChanges"
		| "injuryChanges"
		| "transactionChanges"
		| "depthChanges"
		| "rapidReversals",
) => teamRows.reduce((n, row) => n + row[key], 0);
const aggregate = {
	leagues: reports.length,
	seasons: reports.reduce((n, r) => n + r.years, 0),
	teamSeasons: teamRows.length,
	games: reports.reduce((n, r) => n + r.gameCount, 0),
	regularGames: reports.reduce(
		(n, r) => n + r.games.filter((g) => !g.playoffs).length / 2,
		0,
	),
	startChanges: sum("startChanges"),
	healthyChanges: sum("healthyChanges"),
	injuryChanges: sum("injuryChanges"),
	transactionChanges: sum("transactionChanges"),
	depthChanges: sum("depthChanges"),
	rapidReversals: sum("rapidReversals"),
	stableTeams: teamRows.filter((r) => r.healthyChanges === 0).length,
	maxHealthyChanges: Math.max(...teamRows.map((r) => r.healthyChanges)),
	firstRoundPositions: Object.fromEntries(
		Object.keys(roles)
			.filter((pos) => pos !== "KR" && pos !== "PR")
			.map((pos) => [pos, firstRound.filter((r) => r.pos === pos).length]),
	),
};
const output = {
	aggregate,
	roles,
	teamRows,
	acquisitions,
	mvpRows,
	firstRound,
	histories,
};
await fs.writeFile(
	path.join(directory, "league-summary.json"),
	JSON.stringify(output),
);
await fs.writeFile(
	path.join(directory, "league-summary.json.gz"),
	gzipSync(JSON.stringify(output)),
);
for (const [index, report] of reports.entries()) {
	if (!files[index]!.endsWith(".gz")) {
		await fs.writeFile(`${files[index]}.gz`, gzipSync(JSON.stringify(report)));
	}
}
console.log(
	JSON.stringify(
		{
			aggregate,
			roles,
			mvpRows: mvpRows.map(
				({ seed, season, name, pos, nextTeam, rank, stillStarting }) => ({
					seed,
					season,
					name,
					pos,
					nextTeam,
					rank,
					stillStarting,
				}),
			),
			acquisitions: {
				firstRoundQBs: acquisitions.length,
				productiveIncumbents: acquisitions.filter((a) => a.productiveIncumbent)
					.length,
				subsequentSignings: acquisitions
					.filter((a) => a.subsequentSignings.length)
					.map((a) => ({
						seed: a.seed,
						season: a.season,
						team: a.team,
						signings: a.subsequentSignings,
					})),
			},
		},
		null,
		2,
	),
);

const esc = (value: unknown) =>
	String(value ?? "—")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
const table = (headers: string[], rows: unknown[][]) =>
	`<div class="table"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
const record = (values: number[]) => values.join("–");
const qblabel = (q: QB) =>
	`${playerLabel(q)} (${q.age}y, ${q.ovr}/${q.pot}, $${(q.contract.amount / 1000).toFixed(1)}m; score ${q.score.score.toFixed(1)})`;
const detailed = [...teamRows]
	.sort(
		(a, b) =>
			b.healthyChanges - a.healthyChanges || b.startChanges - a.startChanges,
	)
	.map((row) => {
		const history = histories.find(
			(h) =>
				h.seed === row.seed && h.season === row.season && h.tid === row.tid,
		)!;
		return `<details><summary>${esc(row.name)} · ${row.season} · seed ${row.seed} · ${row.healthyChanges} healthy changes, ${row.startChanges} total</summary>${table(
			[
				"Game",
				"Record before game",
				"Starter",
				"Depth leader",
				"Available QB scores",
				"Passing / rushing in this game",
			],
			history.games.map((game, index) => {
				const starter = game.qbs.find((q) => q.pid === game.starter);
				const line = game.qbGameStats.find((q) => q.pid === game.starter);
				return [
					index + 1,
					record(game.record),
					starter ? playerLabel(starter) : game.starter,
					game.depthQB[0],
					game.qbs
						.map(
							(q) =>
								`${playerLabel(q)}: ${q.score.score.toFixed(1)}${q.unavailable ? " (unavailable)" : ""}`,
						)
						.join("; "),
					line
						? `${line.pssCmp}/${line.pss}, ${line.pssYds} yd, ${line.pssTD} TD, ${line.pssInt} INT; rush ${line.rus}/${line.rusYds}/${line.rusTD}`
						: "—",
				];
			}),
		)}</details>`;
	})
	.join("");
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Starter Score — generated league audit</title><style>:root{color-scheme:light dark;font:16px/1.55 system-ui}body{margin:0;background:Canvas;color:CanvasText}main{max-width:1150px;margin:auto;padding:30px 24px 70px}h1{font-size:2rem;line-height:1.2}h2{margin-top:36px}p{max-width:90ch}.table{overflow:auto;margin:18px 0}table{border-collapse:collapse;width:100%;font-size:14px;font-variant-numeric:tabular-nums}td,th{padding:10px;text-align:left;vertical-align:top;border-bottom:1px solid color-mix(in srgb,CanvasText 25%,Canvas)}details{padding:14px 0;border-top:1px solid color-mix(in srgb,CanvasText 25%,Canvas)}summary{cursor:pointer;font-weight:650}a{color:light-dark(#145db4,#82baff)}.metrics{display:flex;gap:28px;flex-wrap:wrap}.metric strong{display:block;font-size:2rem}code{font-size:.9em}</style></head><body><main><h1>Starter Score in generated football leagues</h1><p>Two independent 32-team leagues, three seasons each, using the game's random roster generator, game engine, injuries, aging, retirements, trades, drafts, re-signing and free agency. All teams are AI-controlled. These are generated fictional players, not imported NFL rosters. Field length: ${esc(reports.map((r) => r.fieldLength).join(" / "))} yards.</p><div class="metrics"><div class="metric"><strong>${aggregate.teamSeasons}</strong>team-seasons</div><div class="metric"><strong>${aggregate.games}</strong>games, including playoffs</div><div class="metric"><strong>${aggregate.healthyChanges}</strong>healthy QB changes</div><div class="metric"><strong>${aggregate.rapidReversals}</strong>one-game healthy reversals</div></div>
<p><strong>Assessment of this run: lineup stability is encouraging, but redundant QB drafting remains a substantial failure.</strong> The six-draft sample includes 44 first-round QBs and 12 team-draft instances selecting multiple QBs. The intended MVP bonus also misses the current award record format. See the <a href="league-findings.md">findings and concrete examples</a> for the interpretation and remaining problems.</p>
<h2>Quarterback stability</h2>${table(
	["Measure", "Observed"],
	[
		["Total changes in starting QB", aggregate.startChanges],
		["Associated with injury or return from injury", aggregate.injuryChanges],
		["Associated with a roster change", aggregate.transactionChanges],
		["Both QBs available in consecutive games", aggregate.healthyChanges],
		[
			"Team-seasons with no healthy QB change",
			`${aggregate.stableTeams} / ${aggregate.teamSeasons}`,
		],
		[
			"Most healthy changes by one team in a season",
			aggregate.maxHealthyChanges,
		],
		[
			"A → B → A with only one game between healthy changes",
			aggregate.rapidReversals,
		],
		["Changes in top QB on the depth chart", aggregate.depthChanges],
	],
)}<p>“Healthy competition” means both quarterbacks remained on the roster and were available in the two compared pregame snapshots. It can reflect performance, team direction, ratings changes or other score factors. Injury-associated cases can still contain a coaching decision; this classification is descriptive, not a causal proof. Only regular-season games count toward these stability metrics.</p>
<h2>MVPs the following opening day</h2>${table(
	[
		"League seed",
		"Award season",
		"Player",
		"Position",
		"Next team",
		"Depth rank",
		"Starter",
	],
	mvpRows.map((r) => [
		r.seed,
		r.season,
		r.name,
		r.pos,
		r.nextTeam,
		r.rank,
		r.stillStarting ? "Yes" : "No",
	]),
)}
<h2>First-round drafting</h2>${table(["Position", "Selections"], Object.entries(aggregate.firstRoundPositions))}<p>These are actual selections over six drafts, not candidate weights. A first-round quarterback behind a productive veteran is a flag for inspection, not automatically a mistake: age, contract expiry, successor quality and later roster choices matter.</p>${table(
	[
		"Seed / season",
		"Team / record",
		"QB pick",
		"Productive incumbent flag",
		"Additional QBs signed afterward",
		"New QBs retained at next opener",
	],
	acquisitions.map((r) => [
		`${r.seed} / ${r.season}`,
		`${r.team} (${record(r.record)})`,
		`${r.pick}: ${r.rookie}`,
		r.productiveIncumbent ? "Yes" : "No",
		r.subsequentSignings.map((p) => p.name).join("; ") || "None",
		r.addedVeterans.map(playerLabel).join("; ") || "None",
	]),
)}<p>The incumbent flag requires at least 200 passing attempts and a positive performance contribution of at least 3 Starter Score points. Additional signings cover the post-draft offseason through the following preseason; players subsequently cut remain listed as signings.</p>${acquisitions.map((r) => `<details><summary>${esc(r.team)} · ${r.season} · pick ${r.pick}: ${esc(r.rookie)}</summary><p>Before draft: ${esc(r.priorQBs.map(qblabel).join("; "))}</p><p>Next opening roster: ${esc(r.openingQBs.map(qblabel).join("; "))}</p><p>Depth leader: ${esc(r.openingLeader)}</p></details>`).join("")}
<h2>All positions</h2>${table(
	[
		"Role",
		"Starting slots per team",
		"Slot replacements between games",
		"Not associated with injury",
		"% of compared slots replaced",
	],
	Object.entries(roles).map(([role, r]) => [
		role,
		r.slots,
		r.changedSlots,
		r.healthyChangedSlots,
		`${((100 * r.changedSlots) / r.comparisons).toFixed(2)}%`,
	]),
)}<p>This measures membership in each role's starting depth-chart slots, not every on-field substitution. Reordering WR1 and WR2 does not count. The non-injury column can include trades and signings. Multi-position players and varying formations mean these counts should not be compared as if every position had one starter.</p>
<h2>Every team's weekly QB decisions</h2><p>Sorted by healthy changes, then total changes. Expand any row to inspect the actual scores, injury availability and game results.</p>${detailed}
<h2>Method and limits</h2><p>${esc(reports[0]!.methodology)}</p><p>Seeds: ${reports.map((r) => r.seed).join(", ")}. The standard test environment substitutes placeholder names; the report uses player IDs to distinguish them. Ratings, development and game outcomes are generated by the normal game code. Starts are identified from the opening-unit GS records in the game engine. These runs assess this branch's behavior; there is no paired stock-AI control. Two leagues do not establish a population-wide frequency, and three seasons cannot establish long-term dynasty or salary-cap balance. The initial generated league has no played-season history, so later seasons are particularly useful for judging performance memory.</p><p>Reproduce with the opt-in <code>src/test/starterScoreLeague.football.test.ts</code> runner, setting <code>STARTER_SCORE_LEAGUE_REPORT</code>, <code>STARTER_SCORE_SEED</code>, and <code>STARTER_SCORE_YEARS=3</code>. Analyze both outputs with <code>node tools/analysis/analyzeStarterScoreLeagues.ts</code> followed by the two JSON paths.</p><p><a href="report.html">Earlier controlled scenario audit</a> · <a href="league-summary.json.gz">Full derived data (gzip)</a></p></main></body></html>`;
await fs.writeFile(path.join(directory, "league-report.html"), html);
