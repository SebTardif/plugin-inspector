import assert from "node:assert/strict";
import { test } from "node:test";
import { flushWrite } from "../src/flush-write.js";

test("flushWrite does not resolve until the write callback runs", async () => {
  let callback;
  const write = (_chunk, cb) => {
    callback = cb;
    return false;
  };
  let settled = false;
  const pending = flushWrite(write, '{"status":"captured"}\n').then(() => {
    settled = true;
  });

  await Promise.resolve();
  assert.equal(settled, false);
  callback();
  await pending;
  assert.equal(settled, true);
});

test("flushWrite rejects when the write callback reports an error", async () => {
  await assert.rejects(
    () =>
      flushWrite((_chunk, cb) => {
        cb(new Error("EPIPE"));
        return false;
      }, "x\n"),
    /EPIPE/,
  );
});
