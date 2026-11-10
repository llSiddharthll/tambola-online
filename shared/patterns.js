/* Shared by server (Node) and browsers. Pure functions, no dependencies.
 * A ticket is a 3x9 grid: grid[row][col] is a number 1..90 or 0 for a blank. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TambolaShared = Object.assign(root.TambolaShared || {}, factory());
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function flat(grid) {
    const out = [];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 9; c++) if (grid[r][c]) out.push(grid[r][c]);
    return out;
  }
  function rowNums(grid, r) { return grid[r].filter(Boolean); }
  function corners(grid) {
    const top = rowNums(grid, 0), bot = rowNums(grid, 2);
    return [top[0], top[top.length - 1], bot[0], bot[bot.length - 1]];
  }

  // numbers(grid): the numbers that count towards the pattern; min: how many must be called.
  const PATTERNS = {
    early5:  { label: 'Early 5',           family: 'early5',  any: true, numbers: flat,                  min: () => 5 },
    early7:  { label: 'Early 7',           family: 'early7',  any: true, numbers: flat,                  min: () => 7 },
    top:     { label: 'Top Line',          family: 'top',     numbers: (g) => rowNums(g, 0),             min: (n) => n.length },
    middle:  { label: 'Middle Line',       family: 'middle',  numbers: (g) => rowNums(g, 1),             min: (n) => n.length },
    bottom:  { label: 'Bottom Line',       family: 'bottom',  numbers: (g) => rowNums(g, 2),             min: (n) => n.length },
    corners: { label: 'Four Corners',      family: 'corners', numbers: corners,                          min: (n) => n.length },
    full:    { label: 'Full House',        family: 'full',    numbers: flat,                             min: (n) => n.length },
    full2:   { label: 'Second Full House', family: 'full',    numbers: flat,                             min: (n) => n.length },
    full3:   { label: 'Third Full House',  family: 'full',    numbers: flat,                             min: (n) => n.length },
  };

  const PATTERN_ORDER = ['early5', 'early7', 'top', 'middle', 'bottom', 'corners', 'full', 'full2', 'full3'];

  // How many more called numbers this ticket still needs for the pattern.
  function remaining(patternId, grid, calledSet) {
    const p = PATTERNS[patternId];
    const nums = p.numbers(grid);
    let hits = 0;
    for (const n of nums) if (calledSet.has(n)) hits++;
    return Math.max(0, p.min(nums) - hits);
  }
  function isComplete(patternId, grid, calledSet) { return remaining(patternId, grid, calledSet) === 0; }

  // For line-type patterns with exactly one number missing, return that number (else null).
  function missingOne(patternId, grid, calledSet) {
    const p = PATTERNS[patternId];
    if (p.any) return null;
    const nums = p.numbers(grid).filter((n) => !calledSet.has(n));
    return nums.length === 1 ? nums[0] : null;
  }

  function ticketNumbers(grid) { return flat(grid); }

  // Structural validity of a ticket (used by tests and as a server-side sanity check).
  function validTicket(grid) {
    if (!Array.isArray(grid) || grid.length !== 3) return false;
    const seen = new Set();
    const colCount = Array(9).fill(0);
    for (let r = 0; r < 3; r++) {
      if (!Array.isArray(grid[r]) || grid[r].length !== 9) return false;
      let inRow = 0;
      for (let c = 0; c < 9; c++) {
        const v = grid[r][c];
        if (v === 0) continue;
        const lo = c === 0 ? 1 : c * 10, hi = c === 8 ? 90 : c * 10 + 9;
        if (!Number.isInteger(v) || v < lo || v > hi || seen.has(v)) return false;
        seen.add(v); inRow++; colCount[c]++;
      }
      if (inRow !== 5) return false;
    }
    for (let c = 0; c < 9; c++) {
      if (colCount[c] < 1) return false;
      const col = [];
      for (let r = 0; r < 3; r++) if (grid[r][c]) col.push(grid[r][c]);
      for (let i = 1; i < col.length; i++) if (col[i] <= col[i - 1]) return false;
    }
    return seen.size === 15;
  }

  return { PATTERNS, PATTERN_ORDER, remaining, isComplete, missingOne, ticketNumbers, validTicket };
});
