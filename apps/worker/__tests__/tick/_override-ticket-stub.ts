// Recording stand-in for the tick's override ticket.
//
// `buildTickInput` and the replay harness both need one, and most of their tests
// only care that the assembler does not blow up. The ones that DO care read the
// recorded calls instead of a Redis stub, which keeps "the assembler armed the
// ticket" separable from "the ticket re-armed Redis".

import type { OverrideTicket, OverrideTicketArm } from '../../src/tick/override-ticket.js';

export interface RecordingOverrideTicket {
  readonly ticket: OverrideTicket;
  /** Mutated by the ticket; read after the call under test. */
  readonly arms: OverrideTicketArm[];
}

export const createRecordingOverrideTicket = (): RecordingOverrideTicket => {
  const arms: OverrideTicketArm[] = [];
  return {
    arms,
    ticket: {
      arm: (armed) => {
        arms.push(armed);
      },
      whenClaimed: async () => true,
      claimAt: () => null,
      whenPickedUpStamped: async () => undefined,
      markOrderAttempted: () => undefined,
      markDeterministicAbort: () => undefined,
      markSettled: () => undefined,
      compensate: async () => undefined,
    },
  };
};
