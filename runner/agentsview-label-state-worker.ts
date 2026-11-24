import { text } from "node:stream/consumers";
import { LabelStateChangedError, runStateOperation, type StateRequest, type StateReply } from "./agentsview-label-state";

let reply: StateReply;
try {
  const request: StateRequest = JSON.parse(await text(process.stdin));
  reply = { result: runStateOperation(request) };
} catch (error) {
  reply = { error: error instanceof Error ? error.message : String(error), fileChanged: error instanceof LabelStateChangedError };
}
process.stdout.write(JSON.stringify(reply));
