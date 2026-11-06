import { resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { Command, CommanderError } from 'commander';
import type { ConversionRequest } from '../shared/contracts';
import { requestSchema } from '../shared/contracts';

export interface TerminalArguments {
  request: ConversionRequest;
  json: boolean;
  verbose: boolean;
  office?: string;
  report?: string;
}
export function parseArguments(argv: string[], version = '1.0.0'): TerminalArguments | number {
  const command = new Command()
    .name('msg2pdf')
    .description('Convert emails, Office documents and PDFs locally. No files leave your device.')
    .version(version)
    .exitOverride()
    .requiredOption('-i, --input <paths...>', 'Input files or folders')
    .requiredOption('-o, --output <directory>', 'Separate output folder')
    .option('-r, --recursive', 'Include nested input folders', false)
    .option('--extract-attachments', 'Save ordinary attachments beside their PDF', false)
    .option('--all-to-pdf', 'Convert Office documents and copy PDFs too', false)
    .option('--overwrite', 'Replace existing outputs', false)
    .option('--page-size <size>', 'A4 or Letter', 'A4')
    .option('--office <executable>', 'Path to a supported LibreOffice installation')
    .option('--report <file.json>', 'Write a detailed JSON report')
    .option('--json', 'Emit one JSON summary to stdout', false)
    .option('-v, --verbose', 'Print individual file results to stderr', false)
    .addHelpText(
      'after',
      '\nExamples:\n  msg2pdf -i ./mail -o ./pdf --recursive\n  msg2pdf -i first.msg second.eml -o ./pdf --extract-attachments\n  msg2pdf -i ./export -o ./pdf --all-to-pdf --json\n\nExit codes: 0 success, 1 file/conversion failure, 2 invalid arguments, 130 cancelled.\nLinux CLI PDF rendering needs a desktop display or xvfb-run.',
    );
  try {
    command.parse(argv, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 2;
    throw error;
  }
  const parsed = command.opts<{
    input: string[];
    output: string;
    recursive: boolean;
    extractAttachments: boolean;
    allToPdf: boolean;
    overwrite: boolean;
    pageSize: string;
    json: boolean;
    verbose: boolean;
    office?: string;
    report?: string;
  }>();
  const request = requestSchema.parse({
    inputs: parsed.input.map((path) => resolve(path)),
    output: resolve(parsed.output),
    options: {
      recursive: parsed.recursive,
      extractAttachments: parsed.extractAttachments,
      allToPdf: parsed.allToPdf,
      overwrite: parsed.overwrite,
      pageSize: parsed.pageSize,
    },
  });
  if (parsed.report && !parsed.report.toLowerCase().endsWith('.json'))
    throw new Error('The report filename must end in .json');
  return {
    request,
    json: parsed.json,
    verbose: parsed.verbose,
    ...(parsed.office ? { office: resolve(parsed.office) } : {}),
    ...(parsed.report ? { report: resolve(parsed.report) } : {}),
  };
}
export function terminalText(value: string): string {
  return Array.from(stripVTControlCharacters(value), (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || (code >= 127 && code <= 159) ? ' ' : character;
  }).join('');
}
