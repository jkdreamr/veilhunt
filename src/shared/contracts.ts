/**
 * Hidden bonus contracts. These are privately assigned at role reveal, never
 * replace the primary victory condition, and are only disclosed on the results
 * screen.
 */

import { createRng } from './rng.js';
import type { ContractDef, MatchStats, Role } from './types.js';

export const HUNTER_CONTRACTS: ContractDef[] = [
  {
    id: 'hunter.chapelCapture',
    role: 'hunter',
    title: 'Consecrated Ground',
    description: 'Capture the Runner within the chapel walls.',
  },
  {
    id: 'hunter.doubleMark',
    role: 'hunter',
    title: 'Twice Seen',
    description: 'Land two crossbow marks in one match.',
  },
  {
    id: 'hunter.spareSnare',
    role: 'hunter',
    title: 'Economy of Malice',
    description: 'Win without placing every snare.',
  },
  {
    id: 'hunter.lastStand',
    role: 'hunter',
    title: 'Let Them Hope',
    description: 'Let all three seals burn, then stop the escape anyway.',
  },
];

export const RUNNER_CONTRACTS: ContractDef[] = [
  {
    id: 'runner.noHeal',
    role: 'runner',
    title: 'Unbroken',
    description: 'Escape without using the healing shrine.',
  },
  {
    id: 'runner.decoySnare',
    role: 'runner',
    title: "Hunter's Own Teeth",
    description: "Trigger one of the Hunter's snares with an Echo Decoy.",
  },
  {
    id: 'runner.cursedSeal',
    role: 'runner',
    title: 'Blood Rite',
    description: 'Activate the final seal while Cursed.',
  },
  {
    id: 'runner.carryBolt',
    role: 'runner',
    title: 'Trophy',
    description: 'Recover a spent crossbow bolt and carry it to the gate.',
  },
];

/** Deterministically picks one contract per role for a given seed and round. */
export function assignContracts(seed: number, round: number): Record<Role, ContractDef> {
  const rng = createRng((seed ^ (round * 0x9e3779b9)) >>> 0);
  return {
    hunter: rng.pick(HUNTER_CONTRACTS),
    runner: rng.pick(RUNNER_CONTRACTS),
  };
}

/** Extra bookkeeping the match keeps purely to resolve contracts. */
export interface ContractProgress {
  capturedInChapel: boolean;
  marksLanded: number;
  snaresPlaced: number;
  sealsLitWhileCursed: number;
  decoyTriggeredSnare: boolean;
  boltCarriedToGate: boolean;
  allSealsLit: boolean;
  healed: boolean;
}

export function createContractProgress(): ContractProgress {
  return {
    capturedInChapel: false,
    marksLanded: 0,
    snaresPlaced: 0,
    sealsLitWhileCursed: 0,
    decoyTriggeredSnare: false,
    boltCarriedToGate: false,
    allSealsLit: false,
    healed: false,
  };
}

export function evaluateContract(
  contract: ContractDef,
  progress: ContractProgress,
  stats: MatchStats,
  winner: Role | null,
): boolean {
  switch (contract.id) {
    case 'hunter.chapelCapture':
      return winner === 'hunter' && progress.capturedInChapel;
    case 'hunter.doubleMark':
      return progress.marksLanded >= 2;
    case 'hunter.spareSnare':
      return winner === 'hunter' && progress.snaresPlaced < 3;
    case 'hunter.lastStand':
      return winner === 'hunter' && progress.allSealsLit;
    case 'runner.noHeal':
      return winner === 'runner' && !progress.healed;
    case 'runner.decoySnare':
      return progress.decoyTriggeredSnare;
    case 'runner.cursedSeal':
      return progress.sealsLitWhileCursed > 0 && stats.sealsActivated >= 3;
    case 'runner.carryBolt':
      return winner === 'runner' && progress.boltCarriedToGate;
    default:
      return false;
  }
}
