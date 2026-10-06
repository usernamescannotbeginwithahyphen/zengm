import { expect, test } from "vitest";
// @ts-expect-error Node APIs are available in the test runner, not the web build.
import fs from "node:fs/promises";
// @ts-expect-error Node APIs are available in the test runner, not the web build.
import process from "node:process";
import { POSITIONS } from "../../../common/constants.football.ts";
import type { Position } from "../../../common/types.football.ts";
import type { Player, Team } from "../../../common/types.ts";
import { resetCache, resetG } from "../../../test/helpers.ts";
import { idb } from "../../db/index.ts";
import { g } from "../../util/index.ts";
import generate from "../player/generate.ts";
import getBest from "../freeAgents/getBest.ts";
import rosterAutoSort from "./rosterAutoSort.football.ts";
import {
	FOOTBALL_STARTERS,
	getStarterContext,
	getStarterScore,
	prepareFootballRoster,
	updateFootballForm,
	type StarterContext,
} from "./starterScore.football.ts";

type Line = Record<string, number>;
type Profile = {
	name: string;
	ability: number;
	age?: number;
	potential?: number;
	salary?: number;
	round?: number;
	draftAge?: number;
	prior?: Line;
	mvp?: boolean;
};
const lines = {
	cameo: { pssCmp: 2, pss: 3, pssYds: 40, pssTD: 1 },
	steady: { pssCmp: 27, pss: 40, pssYds: 270 },
	good: { pssCmp: 24, pss: 32, pssYds: 300, pssTD: 2, pssSk: 2, pssSkYds: 12 },
	poor: { pssCmp: 18, pss: 35, pssYds: 150, pssInt: 2, pssSk: 3, pssSkYds: 20 },
	ordinary: {
		pssCmp: 21,
		pss: 35,
		pssYds: 220,
		pssTD: 1,
		pssInt: 1,
		pssSk: 2,
		pssSkYds: 12,
	},
	breakout: {
		pssCmp: 25,
		pss: 32,
		pssYds: 330,
		pssTD: 3,
		pssSk: 1,
		pssSkYds: 6,
	},
} satisfies Record<string, Line>;
const context = (overrides: Partial<StarterContext> = {}): StarterContext => ({
	tid: 1,
	season: 2016,
	strategy: "contending",
	won: 8,
	lost: 4,
	tied: 0,
	numGames: 17,
	salaryCap: 200000,
	fieldLength: 100,
	depth: {},
	...overrides,
});
const round = (n: number) => Math.round(n * 1000) / 1000;
const makePlayer = (profile: Profile, pid: number, role: Position = "QB") => {
	const primary = role === "KR" || role === "PR" ? "WR" : role;
	const p = generate(
		1,
		profile.age ?? 28,
		2016 - (profile.draftAge ?? 6),
		true,
		50,
	) as Player;
	p.pid = pid;
	p.firstName = profile.name;
	p.lastName = "Fixture";
	p.ratings[0] = {
		...p.ratings[0],
		pos: primary,
		ovr: profile.ability,
		pot: profile.potential ?? profile.ability,
		fuzz: 0,
		ovrs: Object.fromEntries(
			POSITIONS.map((pos) => [
				pos,
				pos === primary || pos === role ? profile.ability : 0,
			]),
		),
		pots: Object.fromEntries(
			POSITIONS.map((pos) => [
				pos,
				pos === primary || pos === role
					? (profile.potential ?? profile.ability)
					: 0,
			]),
		),
	};
	p.value = profile.ability;
	p.contract = { amount: profile.salary ?? 500, exp: 2018 };
	p.draft.tid = 1;
	p.draft.round = profile.round ?? 0;
	if (profile.prior) {
		p.stats.push({
			...Object.fromEntries(
				Object.entries(profile.prior).map(([key, value]) => [key, value * 16]),
			),
			season: 2015,
			tid: 1,
			playoffs: false,
			gp: 16,
			gs: 16,
		} as Player["stats"][number]);
	}
	if (profile.mvp) {
		p.awards.push({ season: 2015, type: "Most Valuable Player" });
	}
	return p;
};
const addGame = (
	p: Player,
	line: Line | undefined,
	started: boolean,
	ctx: StarterContext,
) => {
	if (!line) {
		return;
	}
	let row = p.stats.find((row) => row.season === ctx.season && !row.playoffs);
	if (!row) {
		row = {
			season: ctx.season,
			tid: 1,
			playoffs: false,
			gp: 0,
			gs: 0,
		} as Player["stats"][number];
		p.stats.push(row);
	}
	const stats = row as unknown as Line;
	for (const [key, value] of Object.entries(line)) {
		stats[key] = (stats[key] ?? 0) + value;
	}
	row.gp = (row.gp ?? 0) + 1;
	row.gs = (row.gs ?? 0) + (started ? 1 : 0);
	updateFootballForm(p, line, ctx.season, ctx.fieldLength);
};

type Scenario = {
	id: string;
	description: string;
	profiles: [Profile, Profile];
	context?: Partial<StarterContext>;
	games?: number;
	role?: Position;
	line: (week: number, player: number, active: number) => Line | undefined;
	injured?: (week: number, player: number) => boolean;
};
const scenarios: Scenario[] = [
	{
		id: "cameo",
		description:
			"Equal ability; starter goes 27/40 for 270 yards and no TD each week. Reserve goes 2/3 for 40 yards and a TD twice, then does not play.",
		profiles: [
			{ name: "Starter", ability: 65 },
			{ name: "Cameo", ability: 65 },
		],
		line: (w, p) => (p === 0 ? lines.steady : w <= 2 ? lines.cameo : undefined),
	},
	{
		id: "proven-slump",
		description:
			"67-rated veteran with a good prior season and $30m contract repeatedly plays poorly; 64-rated reserve plays steady football if promoted.",
		profiles: [
			{ name: "Veteran", ability: 67, salary: 30000, prior: lines.good },
			{ name: "Reserve", ability: 64 },
		],
		line: (_w, p, active) =>
			p === active ? (p === 0 ? lines.poor : lines.steady) : undefined,
	},
	{
		id: "two-bad-games",
		description:
			"Same veteran: two poor games, then good play. Reserve only plays if promoted.",
		profiles: [
			{ name: "Veteran", ability: 67, salary: 30000, prior: lines.good },
			{ name: "Reserve", ability: 64 },
		],
		line: (w, p, active) =>
			p === active
				? p === 0
					? w <= 2
						? lines.poor
						: lines.good
					: lines.steady
				: undefined,
	},
	{
		id: "unproven-slump",
		description:
			"67-rated incumbent without prior results or a large contract; 64-rated reserve available. Incumbent plays poorly repeatedly.",
		profiles: [
			{ name: "Unproven", ability: 67 },
			{ name: "Reserve", ability: 64 },
		],
		line: (_w, p, active) =>
			p === active ? (p === 0 ? lines.poor : lines.steady) : undefined,
	},
	{
		id: "rookie-weak-backup",
		description:
			"Second-year first-rounder, 58 ability/82 potential, prior poor season, $9m contract; 45-rated backup. Starter continues struggling.",
		profiles: [
			{
				name: "Prospect",
				ability: 58,
				potential: 82,
				age: 23,
				round: 1,
				draftAge: 1,
				salary: 9000,
				prior: lines.poor,
			},
			{ name: "Backup", ability: 45 },
		],
		line: (_w, p, active) => (p === active ? lines.poor : undefined),
	},
	{
		id: "rookie-viable-backup",
		description:
			"Same prospect with a credible 60-rated veteran available; the veteran produces steady games when selected.",
		profiles: [
			{
				name: "Prospect",
				ability: 58,
				potential: 82,
				age: 23,
				round: 1,
				draftAge: 1,
				salary: 9000,
				prior: lines.poor,
			},
			{ name: "Veteran", ability: 60, age: 32 },
		],
		line: (_w, p, active) =>
			p === active ? (p === 0 ? lines.poor : lines.steady) : undefined,
	},
	{
		id: "breakout-injury",
		description:
			"68-rated veteran misses weeks 1–6; 63-rated, 24-year-old backup posts breakout games. Injury recovery after week 6 tests whether the job is earned.",
		profiles: [
			{
				name: "Veteran",
				ability: 68,
				salary: 25000,
				age: 32,
				prior: lines.ordinary,
			},
			{ name: "Breakout", ability: 63, potential: 78, age: 24 },
		],
		injured: (w, p) => p === 0 && w <= 6,
		line: (_w, p, active) =>
			p === active ? (p === 1 ? lines.breakout : lines.ordinary) : undefined,
	},
	{
		id: "bench-return",
		description:
			"Young first-rounder struggles; veteran gets the job. Veteran then misses weeks 7–10, giving the prospect a real chance to recover with breakout performances.",
		profiles: [
			{
				name: "Prospect",
				ability: 59,
				potential: 78,
				age: 23,
				round: 1,
				draftAge: 1,
			},
			{ name: "Veteran", ability: 63, age: 32 },
		],
		injured: (w, p) => p === 1 && w >= 7 && w <= 10,
		line: (w, p, active) =>
			p === active
				? p === 0
					? w <= 6
						? lines.poor
						: lines.breakout
					: lines.steady
				: undefined,
	},
	{
		id: "aging-contender",
		description:
			"38-year-old 70-rated QB versus 23-year-old 62/85 successor. Team is 10–2, veteran has an ordinary prior season.",
		profiles: [
			{
				name: "Veteran",
				ability: 70,
				age: 38,
				salary: 30000,
				prior: lines.ordinary,
			},
			{ name: "Successor", ability: 62, potential: 85, age: 23 },
		],
		context: { won: 10, lost: 2 },
		line: (_w, p, active) => (p === active ? lines.ordinary : undefined),
	},
	{
		id: "aging-rebuilder",
		description: "Same players on a 2–10 rebuilding team.",
		profiles: [
			{
				name: "Veteran",
				ability: 70,
				age: 38,
				salary: 30000,
				prior: lines.ordinary,
			},
			{ name: "Successor", ability: 62, potential: 85, age: 23 },
		],
		context: { won: 2, lost: 10, strategy: "rebuilding" },
		line: (_w, p, active) => (p === active ? lines.ordinary : undefined),
	},
	{
		id: "mvp",
		description:
			"68-rated reigning MVP with a good prior season versus a newly drafted first-rounder rated 72/85. MVP continues good play.",
		profiles: [
			{
				name: "MVP",
				ability: 68,
				age: 34,
				salary: 30000,
				prior: lines.good,
				mvp: true,
			},
			{
				name: "Rookie",
				ability: 72,
				potential: 85,
				age: 22,
				round: 1,
				draftAge: 0,
				salary: 9000,
			},
		],
		line: (_w, p, active) => (p === active ? lines.good : undefined),
	},
	{
		id: "exceptional-replacement",
		description:
			"Struggling second-year first-rounder rated 54/68 versus an exceptional new first-rounder rated 78/92.",
		profiles: [
			{
				name: "Struggling pick",
				ability: 54,
				potential: 68,
				age: 23,
				round: 1,
				draftAge: 1,
				salary: 9000,
				prior: lines.poor,
			},
			{
				name: "Exceptional pick",
				ability: 78,
				potential: 92,
				age: 22,
				round: 1,
				draftAge: 0,
				salary: 9000,
			},
		],
		line: (_w, p, active) => (p === active ? lines.ordinary : undefined),
	},
];

const runScenario = async (spec: Scenario) => {
	resetG();
	g.setWithoutSavingToDB("salaryCap", 200000);
	const ctx = context(spec.context);
	const role = spec.role ?? "QB";
	const players = spec.profiles.map((profile, index) =>
		makePlayer(profile, index + 1, role),
	);
	// Fill other starting slots, so WR/OL/defense compete for the final job.
	const fillers = Array.from({ length: FOOTBALL_STARTERS[role] - 1 }, (_, i) =>
		makePlayer({ name: "Other starter", ability: 100 }, i + 3, role),
	);
	const depth = Object.fromEntries(
		POSITIONS.map((pos) => [pos, [...fillers.map((p) => p.pid), 1, 2]]),
	);
	await resetCache({
		players: [...players, ...fillers],
		teams: [{ tid: 1, strategy: ctx.strategy, depth } as Team],
		teamSeasons: [{ ...ctx, rid: 1 }],
	});
	const trace: {
		week: number;
		selected: string;
		depthLeader: string;
		injured: boolean[];
		scores: ReturnType<typeof getStarterScore>[];
	}[] = [];
	const select = async (week: number) => {
		for (const [index, p] of players.entries()) {
			p.injury.gamesRemaining = spec.injured?.(week + 1, index) ? 1 : 0;
		}
		const before = await getStarterContext(1);
		const scores = players.map((p) => getStarterScore(p, role, before));
		await rosterAutoSort(1, false, role);
		const after = (await idb.cache.teams.get(1))!.depth as Record<
			Position,
			number[]
		>;
		const competing = after[role].filter((pid) => pid <= 2);
		const selected = competing.find(
			(pid) => players.find((p) => p.pid === pid)!.injury.gamesRemaining === 0,
		)!;
		trace.push({
			week,
			selected: players.find((p) => p.pid === selected)!.firstName,
			depthLeader: players.find((p) => p.pid === competing[0])!.firstName,
			injured: players.map((p) => p.injury.gamesRemaining > 0),
			scores,
		});
		return selected - 1;
	};
	let active = await select(0);
	for (let week = 1; week <= (spec.games ?? 17); week++) {
		for (const [index, p] of players.entries()) {
			addGame(p, spec.line(week, index, active), index === active, ctx);
		}
		active = await select(week);
	}
	const changes = trace
		.filter(
			(row, index) => index > 0 && row.selected !== trace[index - 1]!.selected,
		)
		.map((row) => ({ afterGame: row.week, to: row.selected }));
	return {
		id: spec.id,
		role,
		description: spec.description,
		profiles: spec.profiles,
		context: ctx,
		initialSelection: trace[0]!.selected,
		changes,
		trace,
	};
};

const positionLines: Record<
	Position,
	{ good: Line; poor: Line; added?: Line }
> = {
	QB: {
		good: lines.good,
		poor: lines.poor,
		added: { rus: 8, rusYds: 65, rusTD: 1 },
	},
	RB: {
		good: { rus: 18, rusYds: 95, rusTD: 1 },
		poor: { rus: 18, rusYds: 40, fmbLost: 1 },
		added: { tgt: 7, rec: 6, recYds: 65, recTD: 1 },
	},
	WR: {
		good: { tgt: 9, rec: 6, recYds: 100, recTD: 1 },
		poor: { tgt: 9, rec: 3, recYds: 25 },
		added: { rus: 2, rusYds: 30, rusTD: 1 },
	},
	TE: {
		good: { tgt: 6, rec: 5, recYds: 65 },
		poor: { tgt: 6, rec: 2, recYds: 15 },
		added: { pba: 12, pbw: 11, rba: 18, rbw: 16 },
	},
	OL: {
		good: { pba: 35, pbw: 31, rba: 25, rbw: 22 },
		poor: { pba: 35, pbw: 18, rba: 25, rbw: 13, skAlw: 3 },
	},
	DL: {
		good: { min: 30, defTckSolo: 3, defTckAst: 2, defSk: 1, defTckLoss: 2 },
		poor: { min: 30, defTckSolo: 1 },
		added: { defFmbFrc: 1, defFmbRec: 1 },
	},
	LB: {
		good: { min: 30, defTckSolo: 6, defTckAst: 4, defTckLoss: 1 },
		poor: { min: 30, defTckSolo: 2 },
		added: { defSk: 1, defInt: 1 },
	},
	CB: {
		good: { min: 30, defTckSolo: 3, defTckAst: 1, defPssDef: 2 },
		poor: { min: 30 },
		added: { defSk: 1, defTckLoss: 1, defInt: 1 },
	},
	S: {
		good: { min: 30, defTckSolo: 5, defTckAst: 2, defPssDef: 1 },
		poor: { min: 30, defTckSolo: 1 },
		added: { defFmbFrc: 1, defInt: 1 },
	},
	K: {
		good: { fga30: 1, fg30: 1, fga40: 2, fg40: 2, xpa: 3, xp: 3 },
		poor: { fga30: 1, fg30: 0, fga40: 2, fg40: 0, xpa: 3, xp: 2 },
	},
	P: {
		good: { pnt: 5, pntYds: 240, pntIn20: 2 },
		poor: { pnt: 5, pntYds: 160, pntTB: 2 },
	},
	KR: {
		good: { kr: 3, krYds: 90 },
		poor: { kr: 3, krYds: 35 },
		added: { krTD: 1 },
	},
	PR: {
		good: { pr: 3, prYds: 40 },
		poor: { pr: 3, prYds: 8 },
		added: { prTD: 1 },
	},
};

const auditPositions = () =>
	POSITIONS.map((pos) => {
		resetG();
		const ctx = context({ depth: { [pos]: [1] } });
		const measure = (line?: Line) => {
			const p = makePlayer({ name: pos, ability: 65 }, 1, pos);
			for (let i = 0; i < 8; i++) {
				addGame(p, line, true, ctx);
			}
			return getStarterScore(p, pos, ctx);
		};
		const input = positionLines[pos];
		return {
			pos,
			inputs: input,
			noEvidence: measure(),
			good: measure(input.good),
			poor: measure(input.poor),
			withAdded: input.added
				? measure({ ...input.good, ...input.added })
				: undefined,
		};
	});

const acquisitions = () => {
	resetG();
	const veteran = makePlayer(
		{ name: "Productive QB", ability: 73, salary: 30000, prior: lines.good },
		1,
	);
	const successor = makePlayer(
		{
			name: "Drafted successor",
			ability: 60,
			potential: 85,
			age: 22,
			round: 1,
			draftAge: 0,
			salary: 3000,
		},
		2,
	);
	const ol = Array.from({ length: 5 }, (_, i) =>
		makePlayer({ name: "Weak OL", ability: 40 }, i + 3, "OL"),
	);
	const ctx = context({ depth: { QB: [1, 2] } });
	const candidates = [
		makePlayer(
			{
				name: "Another QB",
				ability: 70,
				potential: 85,
				age: 22,
				salary: 15000,
			},
			20,
		),
		makePlayer(
			{
				name: "OL upgrade",
				ability: 65,
				potential: 80,
				age: 22,
				salary: 10000,
			},
			21,
			"OL",
		),
		makePlayer({ name: "Elite punter", ability: 100, salary: 500 }, 22, "P"),
	];
	for (const p of candidates) {
		p.tid = -1;
		p.draft.tid = -1;
	}
	const roster = [veteran, successor, ...ol];
	const fit = prepareFootballRoster(roster, ctx);
	const scores = candidates.map((p) => ({
		name: p.firstName,
		...fit(p),
		freeAgent: fit(p, "freeAgent"),
	}));
	return {
		scores,
		preferredFreeAgent: getBest(roster, candidates, 0, ctx)?.firstName,
		beforeSuccessor: prepareFootballRoster(
			[veteran, ...ol],
			ctx,
		)(candidates[0]!).value,
		afterSuccessor: fit(candidates[0]!).value,
	};
};

test("dummy seasons exercise actual depth sorting, score trajectories, and position inputs", async () => {
	const trajectories = [];
	for (const spec of scenarios) {
		trajectories.push(await runScenario(spec));
	}
	const sweep = [];
	for (const gap of [-6, -3, 0, 3, 6]) {
		for (const history of ["none", "ordinary", "good"] as const) {
			for (const pattern of ["poor", "alternating"] as const) {
				const spec: Scenario = {
					id: `${gap}/${history}/${pattern}`,
					description:
						"Fixed contender context; only the selected QB gets a full game. Both players have the same performance pattern when selected.",
					profiles: [
						{
							name: "Incumbent",
							ability: 65 + gap,
							prior: history === "none" ? undefined : lines[history],
						},
						{ name: "Challenger", ability: 65 },
					],
					line: (w, p, active) =>
						p === active
							? pattern === "poor" || w % 2 === 0
								? lines.poor
								: lines.good
							: undefined,
				};
				const result = await runScenario(spec);
				sweep.push({
					gap,
					history,
					pattern,
					initialSelection: result.initialSelection,
					changes: result.changes,
					switches: result.changes.length,
				});
			}
		}
	}
	const positions = auditPositions();
	const byId = new Map(trajectories.map((row) => [row.id, row]));
	for (const id of ["cameo", "two-bad-games", "rookie-weak-backup", "mvp"]) {
		expect(byId.get(id)!.changes, id).toHaveLength(0);
	}
	const veteranBench = byId.get("proven-slump")!.changes[0]!.afterGame;
	const unprovenBench = byId.get("unproven-slump")!.changes[0]!.afterGame;
	const rookieBench = byId.get("rookie-viable-backup")!.changes[0]!.afterGame;
	expect(unprovenBench).toBeGreaterThan(1);
	expect(veteranBench).toBeGreaterThan(unprovenBench);
	expect(veteranBench).toBeLessThanOrEqual(10);
	expect(rookieBench).toBeGreaterThan(2);
	expect(rookieBench).toBeLessThan(17);
	expect(byId.get("breakout-injury")!.trace[6]!.depthLeader).toBe("Breakout");
	expect(byId.get("bench-return")!.trace[10]!.depthLeader).toBe("Prospect");
	expect(byId.get("aging-contender")!.initialSelection).toBe("Veteran");
	expect(byId.get("aging-rebuilder")!.initialSelection).toBe("Successor");
	expect(byId.get("exceptional-replacement")!.initialSelection).toBe(
		"Exceptional pick",
	);
	for (const row of sweep) {
		expect(
			row.switches,
			row.gap + "/" + row.history + "/" + row.pattern,
		).toBeLessThanOrEqual(5);
		for (let i = 1; i < row.changes.length; i++) {
			expect(
				row.changes[i]!.afterGame - row.changes[i - 1]!.afterGame,
			).toBeGreaterThanOrEqual(2);
		}
	}
	const positionThresholds = [];
	for (const pos of POSITIONS) {
		positionThresholds.push(
			await runScenario({
				id: pos,
				role: pos,
				description:
					"67-rated incumbent, good prior season, $4m contract; 64-rated reserve. Other starting slots filled by 100-rated players. Incumbent repeatedly produces the poor stat line from the position audit; reserve produces the good line only if promoted.",
				profiles: [
					{
						name: "Incumbent",
						ability: 67,
						salary: 4000,
						prior: positionLines[pos].good,
					},
					{ name: "Reserve", ability: 64 },
				],
				line: (_w, p, active) =>
					p === active
						? p === 0
							? positionLines[pos].poor
							: positionLines[pos].good
						: undefined,
			}),
		);
	}
	for (const row of positions) {
		expect(row.good.score).toBeGreaterThan(row.poor.score);
	}
	// Three sacks allowed per 35 pass blocks is a sustained protection failure,
	// even after correcting the ordinary block-win baseline.
	const olBench = positionThresholds.find((row) => row.id === "OL")!.changes[0];
	expect(olBench).toBeDefined();
	expect(olBench!.afterGame).toBeLessThanOrEqual(12);
	const decisions = acquisitions();
	expect(decisions.preferredFreeAgent).toBe("OL upgrade");
	expect(decisions.afterSuccessor).toBeLessThan(decisions.beforeSuccessor / 10);
	expect(decisions.scores[0]!.affordableRole).toBe(false);
	expect(decisions.scores[1]!.draftValue).toBeGreaterThan(
		decisions.scores[0]!.draftValue,
	);
	// Filling an entirely empty punter slot with a 100-rated punter can beat a
	// redundant third QB. Both must still trail the needed starting lineman.
	expect(decisions.scores[0]!.draftValue).toBeLessThan(
		decisions.scores[2]!.draftValue,
	);
	expect(decisions.scores[2]!.draftValue).toBeLessThan(
		decisions.scores[1]!.draftValue,
	);
	for (const result of trajectories) {
		for (const row of result.trace) {
			for (const score of row.scores) {
				expect(score.score).toBeGreaterThanOrEqual(0);
				expect(score.score).toBeLessThanOrEqual(100);
			}
		}
	}
	const report = {
		methodology:
			"Synthetic box scores, not real historical player estimates or a probabilistic football season. Uses production getStarterScore, updateFootballForm, rosterAutoSort and acquisition evaluation. Ratings/contract/team record held fixed to isolate performance; only selected players accumulate stats except the explicitly listed cameos. Selection at row N is for the game after N completed appearances/rounds. Injuries affect availability separately from depth order. Fixed 100-yard field. Scores rounded only for report display.",
		lines,
		trajectories,
		sweep,
		positions,
		positionThresholds,
		acquisitions: acquisitions(),
	};
	if (process.env.STARTER_SCORE_REPORT_PATH) {
		await fs.writeFile(
			process.env.STARTER_SCORE_REPORT_PATH,
			JSON.stringify(
				report,
				(_key, value) => (typeof value === "number" ? round(value) : value),
				2,
			),
		);
	}
});
