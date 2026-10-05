import type { LintOptions, ReportedFinding, Syntax, TextEdit } from '../types';
import { lintText } from './lint';

export type Fixed = Readonly<{
	text: string;
	/** How many findings were mended. */
	fixed: number;
}>;

// One fix can uncover another, such as a type mended into one whose criteria
// are the wrong shape. This many rounds is far past any real file, and stops
// two fixes that undo each other from running forever.
const MAX_PASSES = 10;

// The safe fixes that can be applied together: taken in order, skipping any
// that touches text an earlier one already changes.
function compatible(
	findings: ReadonlyArray<ReportedFinding>,
): ReadonlyArray<ReadonlyArray<TextEdit>> {
	const taken: ReadonlyArray<TextEdit>[] = [];
	let end = -1;
	for (const finding of findings) {
		const edits = finding.fix?.safe ? finding.fix.edits : [];
		const first = Math.min(...edits.map((edit) => edit.span.start));
		if (!edits.length || first < end) continue;
		taken.push(edits);
		end = Math.max(...edits.map((edit) => edit.span.end));
	}
	return taken;
}

function apply(text: string, edits: ReadonlyArray<TextEdit>): string {
	return [...edits]
		.sort((a, b) => b.span.start - a.span.start)
		.reduce(
			(current, edit) =>
				current.slice(0, edit.span.start) +
				edit.text +
				current.slice(edit.span.end),
			text,
		);
}

/**
 * The text with every safe fix applied. Only fixes marked safe are taken:
 * the others change what a working request does, and stay quick fixes for a
 * person to accept. A finding that is silenced or switched off is not fixed.
 */
export function fixText(
	text: string,
	options: LintOptions,
	syntax: Syntax = 'js',
): Fixed {
	let current = text;
	let fixed = 0;
	for (let pass = 0; pass < MAX_PASSES; pass += 1) {
		const fixes = compatible(lintText(current, options, syntax).findings);
		if (!fixes.length) break;
		current = apply(current, fixes.flat());
		fixed += fixes.length;
	}
	return { text: current, fixed };
}
