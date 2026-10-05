import { beforeEach, describe, expect, test, vi } from "vitest";
import { PHASE } from "../../../common/constants.ts";
import { POSITIONS } from "../../../common/constants.football.ts";
import type { Position } from "../../../common/types.football.ts";
import type { Player, Team } from "../../../common/types.ts";
import { resetCache, resetG } from "../../../test/helpers.ts";
import { idb } from "../../db/index.ts";
import { g, helpers, local } from "../../util/index.ts";
import { draft, freeAgents, league, player, team } from "../index.ts";
import newPhaseResignPlayers from "../phase/newPhaseResignPlayers.ts";
import { ValueChangeCalculator } from "./ValueChangeCalculator.ts";
import { dropPlayers } from "./checkRosterSizes.ts";
import GameSim from "../GameSim.football/index.ts";
import loadTeams from "../game/loadTeams.ts";
import writePlayerStats from "../game/writePlayerStats.ts";
import generate from "../player/generate.ts";
import getBest from "../freeAgents/getBest.ts";
import rosterAutoSort from "./rosterAutoSort.football.ts";
import {
	getFootballRosterContributions,
	getStarterScore,
	gradeFootballPerformance,
	prepareFootballRoster,
	updateFootballForm,
	type StarterContext,
} from "./starterScore.football.ts";

let nextPid: number;
let context: StarterContext;
const makePlayer = (
	pos: Position,
	ovr: number,
	options: {
		age?: number;
		pot?: number;
		tid?: number;
		amount?: number;
		round?: number;
		yearsSinceDraft?: number;
	} = {},
): Player => {
	const p = generate(
		options.tid ?? 1,
		options.age ?? 28,
		2016 - (options.yearsSinceDraft ?? 6),
		true,
		50,
	) as Player;
	p.pid = nextPid++;
	p.ratings[0] = {
		...p.ratings[0],
		pos,
		ovr,
		pot: options.pot ?? ovr,
		fuzz: 0,
		ovrs: Object.fromEntries(
			POSITIONS.map((role) => [role, role === pos ? ovr : 0]),
		),
		pots: Object.fromEntries(
			POSITIONS.map((role) => [role, role === pos ? (options.pot ?? ovr) : 0]),
		),
	};
	p.value = ovr;
	p.contract.amount = options.amount ?? 500;
	p.draft.round = options.round ?? 0;
	p.draft.tid = p.tid;
	return p;
};
const seasonStats = (
	p: Player,
	stats: Record<string, number>,
	season = 2016,
) => {
	p.stats.push({
		season,
		tid: p.tid,
		playoffs: false,
		gp: 16,
		gs: 16,
		...stats,
	} as Player["stats"][number]);
};
const goodPassing = {
	pss: 480,
	pssYds: 4200,
	pssTD: 35,
	pssInt: 8,
	pssSk: 25,
	pssSkYds: 150,
};
const badPassing = {
	pss: 480,
	pssYds: 2400,
	pssTD: 10,
	pssInt: 25,
	pssSk: 40,
	pssSkYds: 280,
};
const score = (p: Player, ctx = context) =>
	getStarterScore(p, p.ratings[0].pos as Position, ctx).score;

beforeEach(() => {
	resetG();
	nextPid = 1;
	context = {
		tid: 1,
		season: 2016,
		strategy: "contending",
		won: 0,
		lost: 0,
		tied: 0,
		numGames: 17,
		salaryCap: 200000,
		fieldLength: 100,
		depth: {},
	};
	local.autoPlayUntil = undefined;
	local.exhibitionGamePlayers = undefined;
});

describe("one bounded Starter Score", () => {
	test("stays within 0–100 even at extreme ability and performance", () => {
		const star = makePlayer("QB", 100, {
			age: 22,
			round: 1,
			yearsSinceDraft: 0,
			amount: 40000,
		});
		seasonStats(star, goodPassing);
		expect(score(star)).toBe(100);
		const bad = makePlayer("QB", 0, { age: 45 });
		seasonStats(bad, badPassing);
		expect(score(bad)).toBe(0);
		for (const pos of POSITIONS) {
			for (const p of [star, bad]) {
				const value = getStarterScore(p, pos, context).score;
				expect(Number.isFinite(value)).toBe(true);
				expect(value).toBeGreaterThanOrEqual(0);
				expect(value).toBeLessThanOrEqual(100);
			}
		}
	});

	test("protects a productive MVP over a marginally higher rated replacement", () => {
		const veteran = makePlayer("QB", 68, { age: 34, amount: 30000 });
		seasonStats(veteran, goodPassing, 2015);
		veteran.awards.push({ season: 2015, type: "Most Valuable Player" });
		context.depth.QB = [veteran.pid];
		const replacement = makePlayer("QB", 72, { age: 22, pot: 85, tid: -2 });
		expect(score(veteran)).toBeGreaterThan(score(replacement));
		expect(
			prepareFootballRoster([veteran], context)(replacement).starterGain,
		).toBe(0);
	});

	test("allows a backup's sustained breakout to overcome the incumbent", () => {
		const incumbent = makePlayer("QB", 67, { amount: 30000 });
		const breakout = makePlayer("QB", 63, { age: 24 });
		context.depth.QB = [incumbent.pid, breakout.pid];
		seasonStats(breakout, goodPassing);
		expect(score(breakout)).toBeGreaterThan(score(incumbent));
	});

	test("gives a struggling first-rounder patience without making him irreplaceable", () => {
		const rookie = makePlayer("QB", 58, {
			age: 23,
			pot: 82,
			round: 1,
			yearsSinceDraft: 1,
			amount: 9000,
		});
		seasonStats(rookie, badPassing, 2015);
		context.depth.QB = [rookie.pid];
		const lateral = makePlayer("QB", 57, { tid: -2, age: 28 });
		const exceptional = makePlayer("QB", 78, { tid: -2, age: 22, pot: 92 });
		expect(score(rookie)).toBeGreaterThan(score(lateral));
		expect(score(exceptional)).toBeGreaterThan(score(rookie));
		const noInvestment = structuredClone(rookie);
		noInvestment.draft.round = 7;
		expect(score(noInvestment)).toBeLessThan(score(rookie));
	});

	test("a losing team favors a young successor while a winning team keeps its veteran", () => {
		const old = makePlayer("QB", 70, { age: 38, amount: 30000 });
		const young = makePlayer("QB", 62, { age: 23, pot: 85 });
		context.depth.QB = [old.pid, young.pid];
		const losing: StarterContext = { ...context, won: 2, lost: 10 };
		const winning: StarterContext = {
			...context,
			strategy: "rebuilding",
			won: 10,
			lost: 2,
		};
		expect(score(young, losing)).toBeGreaterThan(score(old, losing));
		expect(score(old, winning)).toBeGreaterThan(score(young, winning));
	});

	test("a benched prospect can recover with improved play", () => {
		const prospect = makePlayer("QB", 59, {
			age: 23,
			pot: 78,
			round: 1,
			yearsSinceDraft: 1,
		});
		const veteran = makePlayer("QB", 63, { age: 32 });
		context.depth.QB = [prospect.pid, veteran.pid];
		seasonStats(prospect, badPassing);
		for (let i = 0; i < 6; i++) {
			updateFootballForm(
				prospect,
				{ pss: 30, pssYds: 120, pssInt: 2 },
				2016,
				100,
			);
		}
		expect(score(prospect)).toBeLessThan(score(veteran));
		context.depth.QB = [veteran.pid, prospect.pid];
		for (let i = 0; i < 6; i++) {
			updateFootballForm(
				prospect,
				{ pss: 30, pssYds: 330, pssTD: 3 },
				2016,
				100,
			);
		}
		expect(score(prospect)).toBeGreaterThan(score(veteran));
	});

	test("old success and rookie investment expire", () => {
		const p = makePlayer("QB", 65, {
			age: 23,
			pot: 80,
			round: 1,
			yearsSinceDraft: 1,
		});
		seasonStats(p, goodPassing, 2013);
		p.awards.push({ season: 2013, type: "Most Valuable Player" });
		expect(getStarterScore(p, "QB", context).performance).toBe(0);
		expect(getStarterScore(p, "QB", context).recognition).toBe(0);
		expect(getStarterScore(p, "QB", { ...context, season: 2019 }).runway).toBe(
			0,
		);
	});

	test("team investment does not transfer to an unrelated buyer", () => {
		const p = makePlayer("QB", 65, {
			age: 23,
			pot: 80,
			round: 1,
			yearsSinceDraft: 1,
			amount: 20000,
		});
		context.depth.QB = [p.pid];
		expect(score(p)).toBeGreaterThan(score(p, { ...context, tid: 2 }));
	});
});

describe("performance evidence", () => {
	test("QB rushing and lost fumbles affect the combined offensive grade", () => {
		const passing = { pss: 35, pssYds: 220, pssTD: 1, pssInt: 1 };
		const mobile = { ...passing, rus: 8, rusYds: 65, rusTD: 1 };
		expect(gradeFootballPerformance(mobile, "QB")!.score).toBeGreaterThan(
			gradeFootballPerformance(passing, "QB")!.score,
		);
		expect(
			gradeFootballPerformance({ ...mobile, fmbLost: 1 }, "QB")!.score,
		).toBeLessThan(gradeFootballPerformance(mobile, "QB")!.score);
		expect(
			gradeFootballPerformance({ rus: 8, rusYds: 65, rusTD: 1 }, "QB")!.samples,
		).toBeGreaterThan(0);
	});

	test("RB receiving includes unsuccessful targets and both kinds of touchdowns", () => {
		const line = { rus: 15, rusYds: 60, tgt: 5, rec: 4, recYds: 40 };
		const baseline = gradeFootballPerformance(line, "RB")!.score;
		expect(
			gradeFootballPerformance({ ...line, tgt: 10 }, "RB")!.score,
		).toBeLessThan(baseline);
		expect(
			gradeFootballPerformance({ ...line, recTD: 1 }, "RB")!.score,
		).toBeGreaterThan(baseline);
		expect(
			gradeFootballPerformance({ ...line, rusTD: 1 }, "RB")!.score,
		).toBeGreaterThan(baseline);
	});

	test("WR rushing and TE blocking count alongside receiving", () => {
		const line = { tgt: 9, rec: 5, recYds: 60 };
		expect(
			gradeFootballPerformance({ ...line, rus: 2, rusYds: 30, rusTD: 1 }, "WR")!
				.score,
		).toBeGreaterThan(gradeFootballPerformance(line, "WR")!.score);
		const blocks = { ...line, pba: 15, rba: 15 };
		expect(
			gradeFootballPerformance({ ...blocks, pbw: 13, rbw: 13 }, "TE")!.score,
		).toBeGreaterThan(
			gradeFootballPerformance({ ...blocks, pbw: 7, rbw: 7 }, "TE")!.score,
		);
	});

	test.each(["CB", "S"] as const)(
		"quiet %s coverage is not treated as failure, but recorded plays earn credit",
		(pos) => {
			expect(gradeFootballPerformance({ min: 30 }, pos)!.score).toBe(0);
			for (const play of [
				{ defSk: 1, defTckSolo: 1, defTckLoss: 1 },
				{ defInt: 1 },
				{ defPssDef: 1 },
				{ defTckSolo: 8 },
				{ defFmbFrc: 1 },
				{ defFmbRec: 1 },
			]) {
				expect(
					gradeFootballPerformance({ min: 30, ...play }, pos)!.score,
				).toBeGreaterThan(0);
			}
		},
	);

	test("blocked punts and return touchdowns are accounted for", () => {
		const punts = { pnt: 5, pntYds: 220 };
		expect(
			gradeFootballPerformance({ ...punts, pntBlk: 1 }, "P")!.score,
		).toBeLessThan(gradeFootballPerformance(punts, "P")!.score);
		for (const [pos, key] of [
			["KR", "kr"],
			["PR", "pr"],
		] as const) {
			const line = { [key]: 3, [`${key}Yds`]: pos === "KR" ? 70 : 27 };
			expect(
				gradeFootballPerformance({ ...line, [`${key}TD`]: 1 }, pos)!.score,
			).toBeGreaterThan(gradeFootballPerformance(line, pos)!.score);
		}
	});

	test("does not confuse missing stats or one good pass with a full successful season", () => {
		const empty = makePlayer("QB", 65);
		const small = structuredClone(empty);
		const established = structuredClone(empty);
		seasonStats(small, { pss: 1, pssYds: 20, gs: 0 });
		seasonStats(established, goodPassing);
		expect(getStarterScore(empty, "QB", context).performance).toBe(0);
		expect(score(small) - score(empty)).toBeLessThan(1);
		expect(score(established)).toBeGreaterThan(score(small));
	});

	test.each([
		["RB", { rus: 200, rusYds: 1200 }, { rus: 200, rusYds: 500 }],
		["WR", { tgt: 100, recYds: 1100, recTD: 10 }, { tgt: 100, recYds: 400 }],
		["TE", { tgt: 100, recYds: 1000 }, { tgt: 100, recYds: 400 }],
		["OL", { pba: 600, pbw: 510, skAlw: 2 }, { pba: 600, pbw: 300, skAlw: 15 }],
		["K", { fga40: 30, fg40: 29 }, { fga40: 30, fg40: 10 }],
		["P", { pnt: 60, pntYds: 3000 }, { pnt: 60, pntYds: 1800 }],
		["KR", { kr: 30, krYds: 1000 }, { kr: 30, krYds: 300 }],
		["PR", { pr: 30, prYds: 500 }, { pr: 30, prYds: 100 }],
	] as const)("uses role-specific evidence for %s", (pos, good, bad) => {
		expect(gradeFootballPerformance(good, pos)!.score).toBeGreaterThan(
			gradeFootballPerformance(bad, pos)!.score,
		);
		expect(gradeFootballPerformance({}, pos)).toBeUndefined();
	});

	test("caps defensive box-score influence and requires playing time", () => {
		expect(gradeFootballPerformance({}, "CB")).toBeUndefined();
		expect(
			gradeFootballPerformance({ min: 30, defInt: 10 }, "CB")!.score,
		).toBeLessThanOrEqual(6);
	});

	test("adjusts yardage expectations for a shorter field", () => {
		const line = { pss: 300, pssYds: 1500 };
		expect(gradeFootballPerformance(line, "QB", 50)!.score).toBeGreaterThan(
			gradeFootballPerformance(line, "QB", 100)!.score,
		);
	});

	test("preserves recent evidence across serialization and ignores DNPs", () => {
		const p = makePlayer("QB", 60);
		updateFootballForm(p, { pss: 30, pssYds: 330, pssTD: 3 }, 2016, 100);
		// Test the exported JSON format, not just an in-memory copy.
		const json = JSON.stringify(p);
		const saved = JSON.parse(json) as Player;
		expect(score(saved)).toBe(score(p));
		updateFootballForm(saved, {}, 2016, 100);
		expect(saved.footballForm).toEqual(p.footballForm);
		updateFootballForm(saved, {}, 2017, 100);
		expect(saved.footballForm!.roles).toEqual({});
		p.tid = 2;
		updateFootballForm(p, {}, 2016, 100);
		expect(p.footballForm).toEqual({ tid: 2, season: 2016, roles: {} });
	});
});

describe("position-group decisions from the same score", () => {
	test("prefers a needed lineman over another QB behind a productive starter and rookie", () => {
		const veteran = makePlayer("QB", 73, { amount: 30000 });
		seasonStats(veteran, goodPassing, 2015);
		const backup = makePlayer("QB", 60, {
			age: 22,
			pot: 85,
			round: 1,
			yearsSinceDraft: 0,
		});
		const fit = prepareFootballRoster(
			[
				veteran,
				backup,
				...Array.from({ length: 5 }, () => makePlayer("OL", 40)),
			],
			context,
		);
		const qb = makePlayer("QB", 70, { tid: -2, age: 22, pot: 85 });
		const ol = makePlayer("OL", 65, { tid: -2, age: 22, pot: 80 });
		expect(fit(ol).draftValue).toBeGreaterThan(fit(qb).draftValue);
	});

	test("a drafted successor sharply reduces the value of adding another", () => {
		const incumbent = makePlayer("QB", 70);
		const first = makePlayer("QB", 58, { age: 22, pot: 80, tid: -2 });
		const before = prepareFootballRoster([incumbent], context)(first).value;
		first.tid = 1;
		first.draft.tid = 1;
		first.draft.year = 2016;
		first.draft.round = 1;
		const another = makePlayer("QB", 61, { age: 22, pot: 80, tid: -2 });
		const after = prepareFootballRoster(
			[incumbent, first],
			context,
		)(another).value;
		expect(after).toBeLessThan(before / 4);
	});

	test("weights positional value so even elite specialists trail ordinary early-round prospects", () => {
		const fit = prepareFootballRoster([], context);
		const ol = makePlayer("OL", 55, { tid: -2 });
		for (const pos of ["K", "P"] as const) {
			expect(fit(makePlayer(pos, 100, { tid: -2 })).draftValue).toBeLessThan(
				fit(ol).draftValue,
			);
		}
	});

	test("needs all five starting linemen and reduces returns after starters are covered", () => {
		const linemen = Array.from({ length: 8 }, () => makePlayer("OL", 60));
		const candidate = makePlayer("OL", 60, { tid: -1 });
		const missing = prepareFootballRoster(
			linemen.slice(0, 4),
			context,
		)(candidate).value;
		const covered = prepareFootballRoster(linemen, context)(candidate).value;
		expect(missing).toBeGreaterThan(covered * 20);
	});

	test("a maximum-score starter cannot be improved upon", () => {
		const star = makePlayer("QB", 100);
		const candidate = makePlayer("QB", 100, { tid: -1 });
		expect(prepareFootballRoster([star], context)(candidate).starterGain).toBe(
			0,
		);
	});

	test("values emergency injury cover without erasing the injured player's score", () => {
		const qb = makePlayer("QB", 80);
		const replacement = makePlayer("QB", 60, { tid: -1, amount: 10000 });
		const healthyScore = score(qb);
		qb.injury.gamesRemaining = 8;
		const fit = prepareFootballRoster([qb], context)(replacement, "freeAgent");
		expect(score(qb)).toBe(healthyScore);
		expect(fit.fillsNeed).toBe(true);
		expect(fit.affordableRole).toBe(true);
	});

	test("redundant backup contribution falls below a needed starter", () => {
		const qbs = [
			makePlayer("QB", 80),
			makePlayer("QB", 70),
			makePlayer("QB", 65),
		];
		const ol = makePlayer("OL", 50);
		const contributions = getFootballRosterContributions([...qbs, ol], context);
		expect(contributions.get(ol)!).toBeGreaterThan(contributions.get(qbs[2]!)!);
	});

	test("free agency rejects an expensive redundant QB even before the roster is full", () => {
		const qbs = [makePlayer("QB", 80), makePlayer("QB", 65)];
		const duplicate = makePlayer("QB", 70, { tid: -1, amount: 15000 });
		const needed = makePlayer("OL", 60, { tid: -1, amount: 10000 });
		expect(getBest(qbs, [duplicate], 0, context)).toBeUndefined();
		expect(getBest(qbs, [duplicate, needed], 0, context)).toBe(needed);
	});

	test("mandatory minimum-contract fills work when minimum and maximum roster sizes are equal", () => {
		g.setWithoutSavingToDB("minRosterSize", 2);
		g.setWithoutSavingToDB("maxRosterSize", 2);
		const qb = makePlayer("QB", 80);
		const ol = makePlayer("OL", 50, { tid: -1 });
		ol.contract.amount = g.get("minContract");
		expect(getBest([qb], [ol], undefined, context)).toBe(ol);
	});

	test("free agency can still add an affordable backup and an emergency starter", () => {
		const qb = makePlayer("QB", 80);
		const backup = makePlayer("QB", 55, { tid: -1 });
		expect(getBest([qb], [backup], 0, context)).toBe(backup);
		qb.injury.gamesRemaining = 5;
		backup.contract.amount = 5000;
		expect(getBest([qb], [backup], 0, context)).toBe(backup);
	});

	test("AI auto-sort uses Starter Score while user auto-sort preserves its existing rules", async () => {
		const veteran = makePlayer("QB", 65);
		seasonStats(veteran, goodPassing, 2015);
		const challenger = makePlayer("QB", 68);
		const depth = Object.fromEntries(
			POSITIONS.map((pos) => [pos, [veteran.pid, challenger.pid]]),
		);
		await resetCache({
			players: [veteran, challenger],
			teams: [{ tid: 1, strategy: "contending", depth } as Team],
		});
		await rosterAutoSort(1);
		expect(
			((await idb.cache.teams.get(1))!.depth as Record<Position, number[]>)
				.QB[0],
		).toBe(veteran.pid);
		g.setWithoutSavingToDB("userTids", [1]);
		await rosterAutoSort(1);
		expect(
			((await idb.cache.teams.get(1))!.depth as Record<Position, number[]>)
				.QB[0],
		).toBe(challenger.pid);
	});

	test("equal maximum scores keep the incumbent in the AI depth chart", async () => {
		const old = makePlayer("QB", 100);
		const newcomer = makePlayer("QB", 100);
		const depth = Object.fromEntries(
			POSITIONS.map((pos) => [pos, [old.pid, newcomer.pid]]),
		);
		await resetCache({
			players: [old, newcomer],
			teams: [{ tid: 1, strategy: "contending", depth } as Team],
		});
		await rosterAutoSort(1);
		expect(
			((await idb.cache.teams.get(1))!.depth as Record<Position, number[]>)
				.QB[0],
		).toBe(old.pid);
	});

	test("versatile defenders cannot fill two simultaneous starting jobs", () => {
		const corners = Array.from({ length: 3 }, () => makePlayer("CB", 80));
		for (const p of corners) {
			p.ratings[0].ovrs!.S = 80;
		}
		const safety = makePlayer("S", 55, { tid: -1 });
		const fit = prepareFootballRoster(corners, context)(safety);
		expect(fit.starterGain).toBeGreaterThan(50);
	});

	test("successive cuts preserve a complete starting line", async () => {
		const linemen = Array.from({ length: 8 }, () => makePlayer("OL", 50));
		const corners = Array.from({ length: 4 }, () => makePlayer("CB", 55));
		const roster = [...linemen, ...corners];
		const t = team.generate(helpers.getTeamsDefault()[1]!);
		await resetCache({ players: roster, teams: [t] });
		const released = await dropPlayers(roster, 4);
		expect(released).toHaveLength(4);
		expect(linemen.filter((p) => p.tid === 1)).toHaveLength(5);
		expect(corners.filter((p) => p.tid === 1)).toHaveLength(3);
	});

	test("trading away all interchangeable QBs costs more than selling one spare three times", async () => {
		const qbs = Array.from({ length: 3 }, () => makePlayer("QB", 70));
		await resetCache({
			players: qbs,
			teams: helpers.getTeamsDefault().slice(0, 2).map(team.generate),
		});
		local.playerOvrMean = 50;
		local.playerOvrStd = 10;
		local.playerOvrMeanStdStale = false;
		const calculator = new ValueChangeCalculator();
		const cost = async (pidsRemove: number[]) =>
			-(await calculator.evaluate({
				tid: 1,
				pidsAdd: [],
				pidsRemove,
				dpidsAdd: [],
				dpidsRemove: [],
				tradingPartnerTid: 2,
			}));
		expect(await cost(qbs.map((p) => p.pid))).toBeGreaterThan(
			3 * (await cost([qbs[0]!.pid])),
		);
	});

	test("trades value a needed starter above a redundant player and handle whole packages consistently", async () => {
		const incumbent = makePlayer("QB", 80);
		const backup = makePlayer("QB", 65);
		const incomingQb = makePlayer("QB", 70, { tid: 2 });
		const secondQb = makePlayer("QB", 68, { tid: 2 });
		const incomingOl = makePlayer("OL", 70, { tid: 2 });
		const teams = helpers.getTeamsDefault().slice(0, 3).map(team.generate);
		await resetCache({
			players: [incumbent, backup, incomingQb, secondQb, incomingOl],
			teams,
		});
		local.playerOvrMean = 50;
		local.playerOvrStd = 10;
		local.playerOvrMeanStdStale = false;
		const calculator = new ValueChangeCalculator();
		const evaluate = (pidsAdd: number[], pidsRemove: number[] = []) =>
			calculator.evaluate({
				tid: 1,
				pidsAdd,
				pidsRemove,
				dpidsAdd: [],
				dpidsRemove: [],
				tradingPartnerTid: 2,
			});
		expect(await evaluate([incomingOl.pid])).toBeGreaterThan(
			await evaluate([incomingQb.pid]),
		);
		expect(await evaluate([incomingQb.pid, secondQb.pid])).toBeCloseTo(
			await evaluate([secondQb.pid, incomingQb.pid]),
		);
		// Removing the incumbents creates a real vacancy before incoming players are evaluated.
		const removal = await evaluate([], [incumbent.pid, backup.pid]);
		const replacement = await evaluate(
			[incomingQb.pid],
			[incumbent.pid, backup.pid],
		);
		expect(replacement - removal).toBeGreaterThan(
			await evaluate([incomingQb.pid]),
		);
	});
});

test("renewals fill the starting group before rejecting expensive surplus depth", async () => {
	const linemen = Array.from({ length: 6 }, () =>
		makePlayer("OL", 60, { amount: 10000 }),
	);
	for (const p of linemen) {
		p.contract.exp = 2016;
	}
	const defaults = helpers.getTeamsDefault().slice(0, 2);
	await resetCache({
		players: linemen,
		teams: defaults.map(team.generate),
		teamSeasons: defaults.map((t) => team.genSeasonRow(t)),
	});
	g.setWithoutSavingToDB("numTeams", 2);
	g.setWithoutSavingToDB("numActiveTeams", 2);
	g.setWithoutSavingToDB("phase", PHASE.RESIGN_PLAYERS);
	try {
		// Keep market demands and willingness deterministic; run the actual
		// renewal loop, including signing and releasing players in the cache.
		vi.spyOn(freeAgents, "normalizeContractDemands").mockImplementation(
			async () => {
				for (const p of linemen) {
					p.contract.exp = 2018;
				}
				await idb.cache.players.putAll(linemen);
			},
		);
		vi.spyOn(player, "moodInfo").mockResolvedValue({ willing: true } as Awaited<
			ReturnType<typeof player.moodInfo>
		>);
		vi.spyOn(ValueChangeCalculator.prototype, "evaluate").mockResolvedValue(-1);
		vi.spyOn(draft, "genPlayers").mockResolvedValue(undefined);
		vi.spyOn(league, "setGameAttributes").mockResolvedValue(undefined);
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		await newPhaseResignPlayers({});
		expect(linemen.filter((p) => p.tid === 1)).toHaveLength(5);
		expect(linemen.filter((p) => p.tid === -1)).toHaveLength(1);
	} finally {
		vi.restoreAllMocks();
	}
});

test.each([50, 100])(
	"real simulated games update hidden evidence on a %i-yard field",
	async (fieldLength) => {
		g.setWithoutSavingToDB("fieldLength", fieldLength);
		g.setWithoutSavingToDB("injuryRate", 0);
		const defaults = helpers.getTeamsDefault().slice(0, 2);
		await resetCache({
			players: defaults.flatMap((t) =>
				Array.from({ length: 55 }, () => generate(t.tid, 25, 2010, true, 50)),
			),
			teams: defaults.map(team.generate),
			teamSeasons: defaults.map((t) => team.genSeasonRow(t)),
			teamStats: defaults.map((t) => team.genStatsRow(t.tid)),
		});
		for (let game = 0; game < 3; game++) {
			await rosterAutoSort(0);
			await rosterAutoSort(1);
			const loaded = await loadTeams([0, 1], {});
			for (const t of [loaded[0], loaded[1]]) {
				if (t.depth) {
					t.depth = team.getDepthPlayers(t.depth, t.player);
				}
			}
			const result = new GameSim({
				gid: game,
				teams: [loaded[0], loaded[1]],
				baseInjuryRate: 0,
				doPlayByPlay: false,
				homeCourtFactor: 1,
				allStarGame: false,
				neutralSite: false,
			}).run();
			await writePlayerStats([result], {});
		}
		const players = await idb.cache.players.getAll();
		const withEvidence = players.filter(
			(p) => Object.keys(p.footballForm?.roles ?? {}).length > 0,
		);
		expect(withEvidence.length).toBeGreaterThan(20);
		for (const p of withEvidence) {
			expect(p.footballForm!.season).toBe(2016);
			for (const evidence of Object.values(p.footballForm!.roles)) {
				expect(Number.isFinite(evidence.score)).toBe(true);
				expect(evidence.samples).toBeGreaterThan(0);
			}
			expect(Number.isFinite(score(p))).toBe(true);
		}
	},
);
