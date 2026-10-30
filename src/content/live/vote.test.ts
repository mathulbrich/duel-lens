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
      confident: true,
    }));
  it("keeps the ids but is not confident when the engine is unsure", () =>
    expect(readOf(response({ confident: false }))).toEqual({
      cardId: 7,
      imageId: 70,
      confident: false,
    }));
  it("treats face-down as not confident", () =>
    expect(readOf(response({ faceDown: true })).confident).toBe(false));
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
