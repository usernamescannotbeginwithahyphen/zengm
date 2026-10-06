import {
	POSITIONS,
	POSITION_COUNTS,
} from "../../../common/constants.football.ts";
import type {
	Position,
	PrimaryPosition,
} from "../../../common/types.football.ts";
import type { PlayerWithoutKey, Team } from "../../../common/types.ts";
import { last } from "../../../common/utils.ts";
import {
	DEFAULT_PLAY_THROUGH_INJURIES,
	PHASE,
} from "../../../common/constants.ts";
import { g } from "../../util/index.ts";
import { idb } from "../../db/index.ts";
import fuzzRating from "../player/fuzzRating.ts";

const bound = (value: number, min: number, max: number) =>
	Math.max(min, Math.min(max, value));

// Rotations and backups matter, but a third QB should not be valued like a starter.
export const FOOTBALL_STARTERS: Record<Position, number> = {
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
	KR: 1,
	PR: 1,
};
const ROSTER_TARGETS: Record<PrimaryPosition, number> = {
	...POSITION_COUNTS,
	QB: 2,
};
const ROLE_WEIGHTS: Record<PrimaryPosition, number> = {
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
const PRIMARY_POSITIONS = Object.keys(ROLE_WEIGHTS) as PrimaryPosition[];

export type StarterContext = {
	tid: number;
	season: number;
	strategy: Team["strategy"];
	won: number;
	lost: number;
	tied: number;
	numGames: number;
	salaryCap: number;
	fieldLength: number;
	depth: Partial<Record<Position, number[]>>;
	unavailable?: number[];
};

export const getStarterContext = async (
	tid: number,
): Promise<StarterContext> => {
	const t = await idb.cache.teams.get(tid);
	const season = g.get("season");
	const roster = await idb.cache.players.indexGetAll("playersByTid", tid);
	const playThrough =
		t && g.get("userTids").includes(tid) && !g.get("spectator")
			? (t.playThroughInjuries ?? DEFAULT_PLAY_THROUGH_INJURIES)
			: DEFAULT_PLAY_THROUGH_INJURIES;
	const ts = await idb.cache.teamSeasons.indexGet("teamSeasonsBySeasonTid", [
		season,
		tid,
	]);
	return {
		tid,
		season,
		strategy: t?.strategy ?? "contending",
		won: ts?.won ?? 0,
		lost: ts?.lost ?? 0,
		tied: ts?.tied ?? 0,
		numGames: g.get("numGames"),
		salaryCap: g.get("salaryCap"),
		fieldLength: g.get("fieldLength"),
		depth: (t?.depth ?? {}) as StarterContext["depth"],
		unavailable: roster
			.filter(
				(p) =>
					p.injury.gamesRemaining >
					playThrough[g.get("phase") === PHASE.PLAYOFFS ? 1 : 0],
			)
			.map((p) => p.pid),
	};
};

type StatLine = Record<string, number | undefined>;

// Efficiency rather than raw totals: playing more must not automatically earn a
// better grade. Missing/low-opportunity stats are not evidence of poor play.
export const gradeFootballPerformance = (
	stats: StatLine,
	pos: Position,
	fieldLength = 100,
) => {
	const n = (key: string) => (Number.isFinite(stats[key]) ? stats[key]! : 0);
	const sample = (score: number, opportunities: number, perGame: number) => ({
		score: bound(score, -15, 15),
		samples: opportunities / perGame,
	});
	const fieldFactor = bound(fieldLength / 100, 0.65, 1.2);
	if (pos === "QB") {
		const attempts = n("pss") + n("pssSk");
		const opportunities = attempts + n("rus");
		if (opportunities === 0) {
			return;
		}
		const passing =
			n("pssYds") -
			n("pssSkYds") +
			20 * n("pssTD") -
			45 * n("pssInt") -
			5.5 * fieldFactor * attempts;
		const rushing =
			n("rusYds") + 10 * n("rusTD") - 4.5 * fieldFactor * n("rus");
		return sample(
			((passing + rushing - 35 * n("fmbLost")) / opportunities) * 3.5,
			opportunities,
			30,
		);
	}
	if (pos === "RB") {
		// Targets count unsuccessful receiving opportunities too. Imported older
		// stat lines may contain receptions without targets.
		const targets = Math.max(n("tgt"), n("rec"));
		const opportunities = n("rus") + targets;
		if (opportunities === 0) {
			return;
		}
		const rushing =
			n("rusYds") + 10 * n("rusTD") - 4.5 * fieldFactor * n("rus");
		const receiving = n("recYds") + 10 * n("recTD") - 6 * fieldFactor * targets;
		return sample(
			((rushing + receiving - 35 * n("fmbLost")) / opportunities) * 4,
			opportunities,
			15,
		);
	}
	if (pos === "WR" || pos === "TE") {
		const targets = Math.max(n("tgt"), n("rec"));
		const blocks = pos === "TE" ? n("pba") + n("rba") : 0;
		// Blocking is a secondary part of a TE's evidence. A block is not
		// interchangeable with a target, so use one tenth of its sample weight.
		const blockSamples = blocks * 0.1;
		const opportunities = targets + n("rus") + blockSamples;
		if (opportunities === 0) {
			return;
		}
		const receiving =
			n("recYds") +
			10 * n("recTD") -
			(pos === "TE" ? 6 : 7) * fieldFactor * targets;
		const rushing =
			n("rusYds") + 10 * n("rusTD") - 4.5 * fieldFactor * n("rus");
		const blockingGrade =
			blocks > 0
				? ((n("pbw") + n("rbw")) / blocks - 0.7) * 45 -
					(35 * n("skAlw")) / blocks
				: 0;
		return sample(
			((receiving + rushing - 25 * n("fmbLost")) * 3 +
				blockingGrade * blockSamples) /
				opportunities,
			opportunities,
			6,
		);
	}
	if (pos === "OL") {
		const attempts = n("pba") + n("rba");
		if (attempts === 0) {
			return;
		}
		return sample(
			// The engine's individual block wins are not NFL team pass-block
			// success rates. Generated ordinary starting OL win roughly 60%.
			((n("pbw") + n("rbw")) / attempts - 0.6) * 45 -
				// Sacks allowed belong to pass-block opportunities. Dividing them
				// by run blocks too hid sustained protection failures on run-heavy teams.
				(70 * n("skAlw")) / Math.max(1, n("pba")),
			attempts,
			40,
		);
	}
	if (pos === "K") {
		let attempts = n("xpa") * 0.3;
		let aboveExpected = (n("xp") - n("xpa") * 0.94) * 0.3;
		for (const [range, probability] of [
			["0", 0.97],
			["20", 0.94],
			["30", 0.88],
			["40", 0.75],
			["50", 0.5],
		] as const) {
			attempts += n(`fga${range}`);
			aboveExpected += n(`fg${range}`) - n(`fga${range}`) * probability;
		}
		if (attempts === 0) {
			return;
		}
		return sample((aboveExpected / attempts) * 45, attempts, 3);
	}
	if (pos === "P") {
		const attempts = n("pnt") + n("pntBlk");
		if (attempts === 0) {
			return;
		}
		return sample(
			((n("pntYds") - 13 * n("pntBlk")) / attempts - 43 * fieldFactor) * 0.8 +
				(4 * (n("pntIn20") - n("pntTB"))) / attempts,
			attempts,
			5,
		);
	}
	if (pos === "KR" || pos === "PR") {
		const key = pos.toLowerCase();
		if (n(key) === 0) {
			return;
		}
		return sample(
			((n(`${key}Yds`) + 20 * n(`${key}TD`)) / n(key) -
				(pos === "KR" ? 23 : 9) * fieldFactor) *
				(pos === "KR" ? 0.9 : 1.5),
			n(key),
			3,
		);
	}
	// Coverage targets and defensive snap counts are not recorded. A quiet CB/S
	// might have prevented any throws, so a quiet box score is not negative
	// coverage evidence. Front-seven production is also only a modest proxy.
	if (n("min") < 1) {
		return;
	}
	const tackles = n("defTckSolo") + 0.5 * n("defTckAst");
	const disruptions =
		3 * n("defSk") +
		3 * n("defInt") +
		n("defPssDef") +
		2 * n("defFmbFrc") +
		n("defFmbRec") +
		// Sacks already count as tackles for loss in the simulation.
		0.5 * Math.max(0, n("defTckLoss") - n("defSk")) +
		2 * n("defSft");
	const expected = pos === "LB" ? 7 : pos === "DL" ? 4 : 5;
	const perGame = 30 / n("min");
	const grade =
		pos === "CB" || pos === "S"
			? Math.max(0, tackles * perGame - expected) * 0.6 +
				disruptions * perGame * 1.2
			: ((tackles + disruptions) * perGame - expected) * 1.2;
	return sample(
		bound(grade, pos === "CB" || pos === "S" ? 0 : -3, 6),
		n("min"),
		30,
	);
};

// Persist only recent evidence, not a context-dependent score that becomes stale
// when a player is traded or the team changes direction. DNPs never lower form.
export const updateFootballForm = (
	p: PlayerWithoutKey,
	stats: StatLine,
	season: number,
	fieldLength: number,
) => {
	if (p.footballForm?.season !== season || p.footballForm.tid !== p.tid) {
		p.footballForm = { tid: p.tid, season, roles: {} };
	}
	const primary = last(p.ratings).pos as Position;
	for (const pos of new Set<Position>([primary, "KR", "PR"])) {
		if (!POSITIONS.includes(pos)) {
			continue;
		}
		const grade = gradeFootballPerformance(stats, pos, fieldLength);
		if (!grade || grade.samples <= 0) {
			continue;
		}
		const weight = Math.min(1, grade.samples);
		const previous = p.footballForm.roles[pos];
		const alpha = 1 - 0.82 ** weight;
		p.footballForm.roles[pos] = {
			// Start at neutral evidence; a first appearance is not an established
			// hot/cold streak. Subsequent updates retain more of the prior form.
			score: (previous?.score ?? 0) * (1 - alpha) + grade.score * alpha,
			samples: Math.min(8, (previous?.samples ?? 0) + weight),
		};
	}
};

const rebuildingWeight = (context: StarterContext) => {
	const games = context.won + context.lost + context.tied;
	const winp = games > 0 ? (context.won + 0.5 * context.tied) / games : 0.5;
	const badRecord = games >= Math.max(4, context.numGames * 0.3) && winp < 0.35;
	// A rebuilding team that is unexpectedly winning should not give up on it.
	if (games >= 4 && winp >= 0.65) {
		return 0.15;
	}
	return badRecord ? 1 : context.strategy === "rebuilding" ? 0.75 : 0;
};

export const getStarterScore = (
	p: PlayerWithoutKey,
	pos: Position,
	context: StarterContext,
) => {
	const ratings = last(p.ratings);
	const ability = fuzzRating(
		ratings.ovrs?.[pos] ?? (ratings.pos === pos ? ratings.ovr : 0),
		ratings.fuzz,
	);
	const potential = fuzzRating(
		ratings.pots?.[pos] ??
			(ratings.pos === pos ? ratings.pot : (ratings.ovrs?.[pos] ?? 0)),
		ratings.fuzz,
	);
	const native = ratings.pos === pos;
	const age = context.season - p.born.year;
	const rebuild = rebuildingWeight(context);
	let currentSamples = 0;
	let currentTotal = 0;
	let previousSamples = 0;
	let previousTotal = 0;
	let startsForTeam = 0;
	for (const row of p.stats) {
		if (
			row.playoffs ||
			row.season < context.season - 1 ||
			row.season > context.season
		) {
			continue;
		}
		// Primary-role evidence should not follow someone to an unrelated role.
		if (!native && pos !== "KR" && pos !== "PR") {
			continue;
		}
		const grade = gradeFootballPerformance(
			row as unknown as StatLine,
			pos,
			context.fieldLength,
		);
		if (!grade) {
			continue;
		}
		if (row.season === context.season) {
			currentSamples += grade.samples;
			currentTotal += grade.score * grade.samples;
		} else {
			previousSamples += grade.samples;
			previousTotal += grade.score * grade.samples;
		}
		if (row.tid === context.tid) {
			startsForTeam += row.gs ?? 0;
		}
	}
	// An established previous season is stronger evidence than an empty history.
	// Keep up to eight games of prior confidence, without turning it into immunity
	// to a sustained slump. Tiny previous-year cameos retain the ordinary prior.
	const priorConfidence =
		4 + Math.min(4, previousSamples / 2) * Math.max(0, 1 - currentSamples / 8);
	const currentWeight = currentSamples / (currentSamples + priorConfidence);
	const previous =
		previousSamples > 0
			? ((previousTotal / previousSamples) * previousSamples) /
				(previousSamples + 4)
			: 0;
	let performance =
		currentSamples > 0 ? (currentTotal / currentSamples) * currentWeight : 0;
	performance += previous * (1 - currentWeight) * 0.8;
	const form = p.footballForm;
	const recent =
		form?.season === context.season && form.tid === p.tid
			? form.roles[pos]
			: undefined;
	if (recent) {
		const recentWeight =
			((0.6 * recent.samples) / (recent.samples + 2)) *
			Math.min(1, currentSamples / 4);
		performance =
			performance * (1 - recentWeight) + recent.score * recentWeight;
	}
	const owned = p.tid === context.tid;
	const draftAge = context.season - p.draft.year;
	const developmentYears = bound((27 - age) / 5, 0, 1);
	const runway =
		owned &&
		p.draft.tid === context.tid &&
		draftAge >= 0 &&
		draftAge <= 2 &&
		age <= 26 &&
		native
			? (p.draft.round === 1
					? 8
					: p.draft.round === 2
						? 4
						: p.draft.round === 3
							? 2
							: 0) * [1, 0.8, 0.3][draftAge]!
			: 0;
	const future =
		developmentYears *
		(2 + bound(potential - ability, 0, 25) * (0.1 + 0.25 * rebuild));
	const agingStart =
		pos === "QB" || pos === "K" || pos === "P" ? 32 : pos === "RB" ? 27 : 30;
	const agePenalty = bound(age - agingStart, 0, 10) * (0.15 + rebuild * 1.2);
	const contract =
		owned && p.contract.exp >= context.season && native
			? Math.min(3, (p.contract.amount / Math.max(1, context.salaryCap)) * 30) *
				Math.min(1, (p.contract.exp - context.season + 1) / 2)
			: 0;
	const depthIndex =
		p.pid === undefined ? -1 : (context.depth[pos] ?? []).indexOf(p.pid);
	const availableDepthIndex =
		p.pid === undefined || !context.unavailable
			? -1
			: (context.depth[pos] ?? [])
					.filter((pid) => !context.unavailable!.includes(pid))
					.indexOf(p.pid);
	const incumbent =
		owned &&
		((availableDepthIndex >= 0 &&
			availableDepthIndex < FOOTBALL_STARTERS[pos]) ||
			(depthIndex >= 0
				? depthIndex < FOOTBALL_STARTERS[pos]
				: startsForTeam >= 4));
	const continuity = incumbent
		? // Poor play already lowers performance. Removing all continuity as
			// well caused equally struggling QBs to swap after nearly every game.
			(3 * bound(1 + performance / 10, 1, 1.5) +
				// Proven QBs retain some trust in last year's success while the
				// new season is still a small sample. It fades as evidence arrives.
				(pos === "QB"
					? Math.min(2, Math.max(0, previous) * 0.75) * (1 - currentWeight)
					: 0)) *
			(1 - rebuild * 0.5)
		: 0;
	const recentMvp =
		native &&
		p.awards.some(
			(award) =>
				(award.type === "Most Valuable Player" ||
					("actAs" in award && award.actAs === "mvp" && award.rank === 1)) &&
				award.season >= context.season - 1 &&
				award.season <= context.season,
		);
	const recognition = recentMvp ? 6 * (1 - currentWeight) : 0;
	// One bounded score drives both playing time and roster construction. Position
	// importance is applied to the team's need, never to the player's role score.
	const score = bound(
		ability -
			(native ? 0 : 15) +
			performance +
			runway +
			future -
			agePenalty +
			contract +
			continuity +
			recognition,
		0,
		100,
	);
	return {
		score,
		ability,
		potential,
		performance,
		runway,
		future,
		continuity,
		contract,
		agePenalty,
		recognition,
	};
};

const eligible = (p: PlayerWithoutKey, pos: PrimaryPosition) => {
	// A roster slot belongs to one primary position. Counting a versatile CB
	// again at S would falsely fill two simultaneous starting jobs. Depth charts
	// still evaluate every player's score at every role for emergency cover.
	return last(p.ratings).pos === pos;
};

const roleTotal = (scores: number[], pos: PrimaryPosition) =>
	scores.reduce((total, score, index) => {
		const starters = FOOTBALL_STARTERS[pos];
		const weight =
			index < starters
				? 1
				: 0.18 ** (index - starters + 1) *
					(index >= ROSTER_TARGETS[pos] ? 0.1 : 1);
		return total + score * weight;
	}, 0);

export const prepareFootballRoster = (
	roster: PlayerWithoutKey[],
	context: StarterContext,
) => {
	const roles = new Map(
		PRIMARY_POSITIONS.map((pos) => [
			pos,
			roster
				.filter((p) => eligible(p, pos))
				.map((p) => ({ p, ...getStarterScore(p, pos, context) }))
				.sort((a, b) => b.score - a.score),
		]),
	);
	return (
		candidate: PlayerWithoutKey,
		kind: "draft" | "freeAgent" | "trade" = "draft",
	) => {
		let value = 0;
		let draftValue = 0;
		let starterGain = 0;
		let healthyStarterGain = 0;
		let fillsNeed = false;
		for (const pos of PRIMARY_POSITIONS) {
			if (!eligible(candidate, pos)) {
				continue;
			}
			const incumbents = roles
				.get(pos)!
				.filter(
					(row) =>
						row.p !== candidate &&
						(candidate.pid === undefined || row.p.pid !== candidate.pid),
				);
			const incoming = getStarterScore(candidate, pos, context);
			const starters = FOOTBALL_STARTERS[pos];
			const incumbent = incumbents[starters - 1];
			const upgrade = Math.max(0, incoming.score - (incumbent?.score ?? 0));
			const healthy = incumbents.filter(
				(row) => row.p.injury.gamesRemaining === 0,
			);
			const injuryNeed =
				kind !== "draft" &&
				incumbents.length >= starters &&
				healthy.length < starters &&
				candidate.injury.gamesRemaining === 0;
			if (injuryNeed) {
				healthyStarterGain = Math.max(
					healthyStarterGain,
					incoming.score - (healthy[starters - 1]?.score ?? 0),
				);
			}
			const target = ROSTER_TARGETS[pos];
			const depthNeed = incumbents.length < target;
			const before = incumbents.map((row) => row.score);
			const after = [...before, incoming.score].sort((a, b) => b - a);
			const improvement = roleTotal(after, pos) - roleTotal(before, pos);
			const roleValue =
				ROLE_WEIGHTS[pos] *
				(improvement +
					(injuryNeed
						? Math.max(0, incoming.score - (healthy[starters - 1]?.score ?? 0))
						: 0));
			value = Math.max(value, roleValue);
			// A little best-player-available value, still derived from the SAME
			// Starter Score. Specialists carry much less value in the draft.
			const draftPositionFactor = pos === "K" ? 0.25 : pos === "P" ? 0.15 : 1;
			// Talent at a filled role has the same diminishing returns as roster
			// improvement. An unconditional bonus rewarded redundant first-round
			// QBs even when they were behind a young star AND a drafted successor.
			const rank = before.filter((score) => score >= incoming.score).length;
			const opportunity =
				rank < starters
					? 1
					: 0.18 ** (rank - starters + 1) * (rank >= target ? 0.1 : 1);
			draftValue = Math.max(
				draftValue,
				(roleValue + incoming.score * ROLE_WEIGHTS[pos] * 0.2 * opportunity) *
					draftPositionFactor,
			);
			starterGain = Math.max(starterGain, upgrade);
			fillsNeed ||= depthNeed || injuryNeed;
		}
		const backupBudget =
			context.salaryCap *
			(last(candidate.ratings).pos === "QB" ? 0.015 : 0.008);
		const affordableRole =
			starterGain >= 3 ||
			healthyStarterGain >= 3 ||
			candidate.contract.amount <= backupBudget;
		return { value, draftValue, starterGain, fillsNeed, affordableRole };
	};
};

// Used when cutting and re-signing players. Losing a starter matters more than
// losing the third player at an already-covered role, even at similar ratings.
export const getFootballRosterContributions = (
	roster: PlayerWithoutKey[],
	context: StarterContext,
) => {
	const scores = new Map<PlayerWithoutKey, number>(roster.map((p) => [p, 0]));
	for (const pos of PRIMARY_POSITIONS) {
		const ranked = roster
			.filter((p) => eligible(p, pos))
			.map((p) => ({ p, ...getStarterScore(p, pos, context) }))
			.sort((a, b) => b.score - a.score);
		const all = ranked.map((other) => other.score);
		for (const [index, row] of ranked.entries()) {
			const without = all.filter((_, i) => i !== index);
			const contribution =
				(roleTotal(all, pos) - roleTotal(without, pos)) *
					ROLE_WEIGHTS[pos] *
					8 +
				row.score * 0.08;
			scores.set(row.p, Math.max(scores.get(row.p)!, contribution));
		}
	}
	return scores;
};
