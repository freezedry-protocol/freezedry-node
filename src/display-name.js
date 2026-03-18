/**
 * display-name.js — Deterministic adjective-animal display names from ed25519 pubkeys.
 *
 * Hash the pubkey, pick an adjective + animal from the first 4 bytes.
 * ~10,000 unique combos (100 adjectives × 100 animals). Collision-resistant
 * enough for human-readable node identification. Not security — just UX.
 */

import { createHash } from 'crypto';

const ADJECTIVES = [
  'swift', 'bright', 'calm', 'dark', 'eager', 'fair', 'glad', 'bold', 'keen', 'warm',
  'wild', 'wise', 'cool', 'deep', 'fast', 'firm', 'free', 'gold', 'gray', 'green',
  'lean', 'loud', 'mild', 'neat', 'pale', 'pure', 'rare', 'rich', 'safe', 'soft',
  'tall', 'thin', 'true', 'vast', 'aged', 'blue', 'cold', 'dry', 'dull', 'flat',
  'full', 'hard', 'high', 'hot', 'kind', 'late', 'long', 'lost', 'low', 'new',
  'odd', 'old', 'raw', 'red', 'sad', 'shy', 'sly', 'tan', 'top', 'wet',
  'able', 'bare', 'busy', 'cozy', 'dear', 'easy', 'even', 'fine', 'good', 'half',
  'idle', 'just', 'lazy', 'live', 'lone', 'mere', 'nice', 'open', 'pert', 'real',
  'ripe', 'rude', 'sick', 'slim', 'snug', 'sore', 'sure', 'tame', 'tidy', 'tiny',
  'trim', 'ugly', 'used', 'void', 'wary', 'weak', 'wide', 'worn', 'zero', 'zany',
];

const ANIMALS = [
  'fox', 'owl', 'elk', 'ant', 'bee', 'cat', 'cow', 'dog', 'eel', 'fly',
  'gnu', 'hen', 'jay', 'koi', 'lynx', 'moth', 'newt', 'oryx', 'puma', 'ram',
  'seal', 'toad', 'vole', 'wasp', 'wren', 'yak', 'bass', 'bear', 'boar', 'bull',
  'carp', 'clam', 'colt', 'crab', 'crow', 'dart', 'deer', 'dove', 'duck', 'fawn',
  'frog', 'goat', 'gull', 'hare', 'hawk', 'ibis', 'kite', 'lark', 'lion', 'mink',
  'mole', 'mule', 'pike', 'quail', 'rook', 'slug', 'swan', 'tern', 'tick', 'wolf',
  'worm', 'finch', 'crane', 'eagle', 'egret', 'gecko', 'goose', 'grouse', 'horse', 'heron',
  'koala', 'lemur', 'llama', 'moose', 'mouse', 'otter', 'panda', 'perch', 'robin', 'shark',
  'sheep', 'skunk', 'sloth', 'snail', 'snake', 'squid', 'stork', 'swift', 'tiger', 'trout',
  'viper', 'whale', 'bison', 'camel', 'coral', 'dingo', 'drake', 'ferret', 'hyena', 'raven',
];

/**
 * Generate a deterministic display name from a base58 pubkey string.
 * @param {string} pubkeyBase58 - ed25519 public key in base58
 * @returns {string} e.g. "swift-fox"
 */
export function displayName(pubkeyBase58) {
  if (!pubkeyBase58 || typeof pubkeyBase58 !== 'string') return 'unknown-node';
  const hash = createHash('sha256').update(pubkeyBase58).digest();
  const adjIdx = hash.readUInt16LE(0) % ADJECTIVES.length;
  const aniIdx = hash.readUInt16LE(2) % ANIMALS.length;
  return `${ADJECTIVES[adjIdx]}-${ANIMALS[aniIdx]}`;
}
