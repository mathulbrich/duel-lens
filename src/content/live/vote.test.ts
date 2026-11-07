import { describe, expect, it } from "vitest";
import type { RecognizeResponse } from "../../shared/messages";
import { CARD_BACK_ID } from "../../shared/types";
import { readOf, settle, VOTE, type Read } from "./vote";

const c = (id: number): Read => ({
  cardId: id,
  imageId: id * 10,
  confident: true,
});
const n = (): Read => ({ cardId: null, imageId: null, confident: false });

const response = (
  over: Record<string, unknown>,
  candidates = [{ cardId: 7, imageId: 70, score: 0.9 }],
) =>
  ({
    result: {
      candidates,
      confident: true,
      faceDown: false,
      modelId: "m",
      timings: {},
      ...over,
    },
    cards: {},
    aiEnabled: false,
  }) as unknown as RecognizeResponse;

describe("settle", () => {
  it("one very clear read promotes at once; a clear read beside another card's confident read does not", () => {
    expect(settle([{ ...c(5), score: VOTE.clear }])).toMatchObject({ state: "promoted", cardId: 5 });
    expect(settle([{ ...c(5), score: VOTE.clear - 0.01 }]).state).toBe("voting");
    expect(settle([{ ...c(5), score: 0.95, confident: false }]).state).toBe("voting");
    expect(settle([c(6), { ...c(5), score: 0.95 }]).state).toBe("voting");
  });

  it("a cut card's high rescue answer is a confident vote: two agreeing reads list it; one lists it only from VOTE.cut.alone", () => {
    const cut = (score: number, second = 0.5, over: Record<string, unknown> = {}) =>
      readOf(response({ confident: false, truncated: true, ...over }, [{ cardId: 7, imageId: 70, score }, { cardId: 8, imageId: 80, score: second }]));
    expect(cut(0.87)).toEqual({ cardId: 7, imageId: 70, confident: true }); // under VOTE.cut.alone: no score
    expect(settle([cut(0.87)]).state).toBe("voting");
    expect(settle([cut(0.87), cut(0.86)])).toMatchObject({ state: "promoted", cardId: 7 });
    expect(cut(0.95)).toEqual({ cardId: 7, imageId: 70, confident: true, score: 0.95 });
    expect(settle([cut(0.95)])).toMatchObject({ state: "promoted", cardId: 7 }); // clear enough alone
    expect(cut(0.84).confident).toBe(false); // under VOTE.cut.score
    expect(cut(0.9, 0.81).confident).toBe(false); // lead under VOTE.cut.lead
    expect(readOf(response({ confident: false }, [{ cardId: 7, imageId: 70, score: 0.95 }])).confident).toBe(false); // not cut
    expect(cut(0.95, 0.5, { faceDown: true }).confident).toBe(false);
    expect(cut(0.95, 0.5, { error: "x" }).confident).toBe(false);
  });

  it("readOf keeps the top score", () => {
    expect(readOf(response({})).score).toBe(0.9);
  });

  it("promotes on 2 confident reads of the same card", () =>
    expect(settle([c(1), n(), c(1)])).toEqual({
      state: "promoted",
      cardId: 1,
      imageId: 10,
    }));
  it("keeps voting on one confident read", () =>
    expect(settle([c(1), n()]).state).toBe("voting"));
  it("never promotes when another card was read confidently", () =>
    expect(settle([c(1), c(2), c(1)]).state).toBe("voting"));
  it("rejects after 4 reads without promotion", () => {
    expect(VOTE.readLimit).toBe(4);
    expect(settle([c(1), n(), n(), n()])).toEqual({ state: "rejected" });
  });
  it("keeps voting under the read limit with nothing read", () =>
    expect(settle([n(), n(), n()]).state).toBe("voting"));
});

describe("readOf", () => {
  it("reads a confident face-up top candidate", () =>
    expect(readOf(response({}))).toEqual({
      cardId: 7,
      imageId: 70,
      score: 0.9,
      confident: true,
    }));
  it("keeps the ids but is not confident when the engine is unsure", () =>
    expect(readOf(response({ confident: false }))).toEqual({
      cardId: 7,
      imageId: 70,
      score: 0.9,
      confident: false,
    }));
  it("treats face-down as not confident", () =>
    expect(readOf(response({ faceDown: true })).confident).toBe(false));
  it("is not confident when the answer carries an error, whatever the candidates say", () =>
    expect(readOf(response({ error: "model failed to load" })).confident).toBe(false));
  it("treats a card back as not confident", () => {
    const r = readOf(
      response({}, [{ cardId: CARD_BACK_ID, imageId: 0, score: 0.9 }]),
    );
    expect(r.confident).toBe(false);
  });
  it("has no card when there are no candidates", () =>
    expect(readOf(response({}, []))).toEqual({
      cardId: null,
      imageId: null,
      confident: false,
    }));
  it("treats an error as not confident", () =>
    expect(readOf({ error: "boom" })).toEqual({
      cardId: null,
      imageId: null,
      confident: false,
    }));
});
