import {
	afterEach,
	assert,
	beforeAll,
	beforeEach,
	describe,
	test,
	vi,
} from "vitest";
import { genTwoTeams, initGameSim } from "./index.test.ts";
import Play from "./Play.ts";
import { g } from "../../util/index.ts";

beforeAll(genTwoTeams);

describe.each([50, 75, 100, 110, 150])("%i-yard field", (fieldLength) => {
	beforeEach(() => {
		g.setWithoutSavingToDB("fieldLength", fieldLength);
	});
	afterEach(() => {
		g.setWithoutSavingToDB("fieldLength", 100);
		vi.restoreAllMocks();
	});

	const setupPlay = async (scrimmage: number) => {
		const game = await initGameSim();
		game.awaitingKickoff = undefined;
		game.o = 0;
		game.d = 1;
		game.down = 1;
		game.toGo = Math.min(10, fieldLength - scrimmage);
		game.scrimmage = scrimmage;
		game.currentPlay = new Play(game);
		game.updatePlayersOnField("run");
		return { game, play: game.currentPlay, p: game.pickPlayer(0) };
	};

	test("bounds gains at the goal line and scores touchdowns", async () => {
		const { play, p } = await setupPlay(fieldLength - 5);
		assert.equal(play.boundedYds(80), 5);
		const result = play.addEvent({ type: "rus", p, yds: play.boundedYds(80) });
		assert.isTrue(result.td);
		play.addEvent({ type: "rusTD", p });
		assert.equal(play.state.current.scrimmage, fieldLength);
		assert.equal(play.state.current.pts[0] - play.state.initial.pts[0], 6);
	});

	test("preserves safety and goal-to-go boundaries", async () => {
		const { play, p } = await setupPlay(3);
		assert.equal(play.boundedYds(-20), -3);
		assert.isTrue(play.addEvent({ type: "rus", p, yds: -3 }).safety);
		play.state.current.scrimmage = fieldLength - 4;
		play.state.current.newFirstDown();
		assert.equal(play.state.current.toGo, 4);
	});

	test("reverses possession and bounds a touchdown return", async () => {
		const { play } = await setupPlay(12);
		play.addEvent({ type: "possessionChange", subtype: "turnover", yds: 0 });
		assert.equal(play.state.current.scrimmage, fieldLength - 12);
		assert.equal(play.boundedYds(200), 12);
		assert.equal(play.state.current.o, 1);
	});

	test("turnover on downs reverses field position", async () => {
		const { play } = await setupPlay(12);
		play.state.current.down = 5;
		play.checkDownAtEndOfPlay(play.state.current);
		assert.isTrue(play.state.current.turnoverOnDowns);
		assert.equal(play.state.current.scrimmage, fieldLength - 12);
	});

	test("defensive penalties stop at the one-yard line", async () => {
		const { play, p } = await setupPlay(fieldLength - 4);
		play.addEvent({
			type: "penalty",
			p,
			t: 1,
			automaticFirstDown: true,
			name: "Face mask",
			penYds: 15,
			spotYds: undefined,
			tackOn: false,
		});
		play.adjudicatePenalties(false);
		assert.equal(play.state.current.scrimmage, fieldLength - 1);
		assert.equal(play.state.current.toGo, 1);
	});

	test("punts and interceptions use the scaled touchback spot", async () => {
		const { game, play, p } = await setupPlay(fieldLength - 30);
		assert.isTrue(play.addEvent({ type: "p", p, yds: 35 }).touchback);
		play.addEvent({ type: "possessionChange", subtype: "punt", yds: 0 });
		play.addEvent({ type: "touchbackPunt", p });
		assert.equal(play.state.current.scrimmage, game.field.touchback);
		play.addEvent({ type: "touchbackInt" });
		assert.equal(play.state.current.scrimmage, game.field.touchback);
	});

	test("field goals use actual distance to the goal posts", async () => {
		const { game } = await setupPlay(fieldLength - 20);
		game.playByPlay.active = true;
		game.doFieldGoal("fieldGoal");
		const attempt = game.playByPlay.playByPlay.find(
			(e) => e.type === "fieldGoalAttempt",
		);
		assert.equal(attempt?.type === "fieldGoalAttempt" && attempt.yds, 37);
	});

	test("shootout kicks remain 50 yards long", async () => {
		const game = await initGameSim();
		game.doShootoutShot(0);
		assert.equal(fieldLength - game.scrimmage + 17, 50);
	});

	test("kickoff stats measure actual yards from the kickoff spot", async () => {
		const game = await initGameSim();
		const play = new Play(game);
		game.updatePlayersOnField("kickoff");
		const kicker = game.getTopPlayerOnField(game.o, "K");
		const kickTo = -5;
		const changes = play.getStatChanges(
			{ type: "k", p: kicker, kickTo },
			play.state.current,
		);
		assert.equal(
			changes.find((change) => change[2] === "koYds")![3],
			fieldLength - game.scrimmage - kickTo,
		);
	});

	test.each(["extraPoint", "twoPointConversion"] as const)(
		"%s starts the correct distance from goal",
		async (playType) => {
			const { game } = await setupPlay(fieldLength);
			game.awaitingAfterTouchdown = true;
			vi.spyOn(game, "getPlayType").mockReturnValue(playType);
			game.playByPlay.active = true;
			game.simPlay();
			const clock = game.playByPlay.playByPlay.find((e) => e.type === "clock");
			assert.equal(
				clock?.type === "clock" && clock.scrimmage,
				fieldLength - (playType === "extraPoint" ? 15 : 2),
			);
			assert.equal(clock?.type === "clock" && clock.fieldLength, fieldLength);
		},
	);

	test("onside kicks travel forward and land inside the field", async () => {
		const game = await initGameSim();
		game.currentPlay = new Play(game);
		game.doKickoff(true);
		const kick = game.currentPlay.events.find(
			(e) => e.event.type === "onsideKick",
		)!.event;
		assert.equal(kick.type, "onsideKick");
		if (kick.type === "onsideKick") {
			const distance = fieldLength - game.scrimmage - kick.kickTo;
			assert.isAtLeast(distance, 10);
			assert.isAtMost(distance, 25);
			assert.isAbove(kick.kickTo, 0);
		}
	});

	test("simulates a complete game with legal snap locations", async () => {
		const game = await initGameSim();
		game.playByPlay.active = true;
		const result = game.run();
		assert.isAbove(result.playByPlay!.length, 100);
		for (const e of result.playByPlay!) {
			if (e.type === "clock") {
				assert.equal(e.fieldLength, fieldLength);
				assert.isAbove(e.scrimmage, 0);
				assert.isBelow(e.scrimmage, fieldLength);
			}
		}
	});
});
