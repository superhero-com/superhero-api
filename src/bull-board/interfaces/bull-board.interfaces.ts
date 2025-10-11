import { BaseAdapter } from '@bull-board/api/baseAdapter';

export interface BullBoard {
  setQueues: (newBullQueues: readonly BaseAdapter[]) => void;
  replaceQueues: (newBullQueues: readonly BaseAdapter[]) => void;
  addQueue: (queue: BaseAdapter) => void;
  removeQueue: (queueOrName: string | BaseAdapter) => void;
}
