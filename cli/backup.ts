import { Command } from "commander";
import fs from "fs";
import path from "path";
import { CLI_DIRS } from "./config.js";
import { log } from "./utils.js";

const BACKUP_VERSION = 1;
const BACKUP_PROJECT = "zk-private-payments";

interface NoteBackupEntry {
  filename: string;
  [key: string]: unknown;
}

interface NotesBackup {
  version: number;
  project: string;
  exportedAt: string;
  noteCount: number;
  notes: NoteBackupEntry[];
}

export function registerBackup(program: Command): void {
  program
    .command("export-notes")
    .description("Export all saved notes to a single backup file")
    .option("--output <path>", "Output file path", "notes-backup.json")
    .addHelpText(
      "after",
      `
Examples:
  $ zk-pay export-notes
  $ zk-pay export-notes --output ~/backup/zk-pay-notes.json
`
    )
    .action(async (opts: { output: string }) => {
      const notesDir = CLI_DIRS.notes;
      if (!fs.existsSync(notesDir)) {
        log.error("No notes directory found. Make deposits first.");
        process.exit(1);
      }

      const files = fs
        .readdirSync(notesDir)
        .filter((f) => f.endsWith(".json"));
      if (files.length === 0) {
        log.error("No notes found in the notes/ directory.");
        process.exit(1);
      }

      const notes: NoteBackupEntry[] = files.map((f) => {
        const content = JSON.parse(
          fs.readFileSync(path.join(notesDir, f), "utf-8")
        ) as Record<string, unknown>;
        return { filename: f, ...content };
      });

      const backup: NotesBackup = {
        version: BACKUP_VERSION,
        project: BACKUP_PROJECT,
        exportedAt: new Date().toISOString(),
        noteCount: notes.length,
        notes,
      };

      fs.writeFileSync(opts.output, JSON.stringify(backup, null, 2));
      log.success(`Exported ${notes.length} note(s) to ${opts.output}`);
    });

  program
    .command("import-notes")
    .description("Import notes from a backup file")
    .requiredOption("--input <path>", "Backup file path")
    .addHelpText(
      "after",
      `
Examples:
  $ zk-pay import-notes --input notes-backup.json
`
    )
    .action(async (opts: { input: string }) => {
      if (!fs.existsSync(opts.input)) {
        log.error(`Backup file not found: ${opts.input}`);
        process.exit(1);
      }

      const raw = JSON.parse(
        fs.readFileSync(opts.input, "utf-8")
      ) as NotesBackup;

      if (!raw.notes || !Array.isArray(raw.notes)) {
        log.error("Invalid backup format: missing notes array.");
        process.exit(1);
      }

      if (raw.project && raw.project !== BACKUP_PROJECT) {
        log.error(
          `Backup is from project "${raw.project}", expected "${BACKUP_PROJECT}".`
        );
        process.exit(1);
      }

      const notesDir = CLI_DIRS.notes;
      fs.mkdirSync(notesDir, { recursive: true });

      let imported = 0;
      const total = raw.notes.length;

      for (const note of raw.notes) {
        const filename =
          note.filename ||
          `${(note["commitment"] as string) ?? Date.now()}.json`;
        const filePath = path.join(notesDir, filename);

        if (fs.existsSync(filePath)) {
          log.step(`Skipping existing: ${filename}`);
          continue;
        }

        const { filename: _, ...noteData } = note;
        fs.writeFileSync(filePath, JSON.stringify(noteData, null, 2));
        imported++;
      }

      const skipped = total - imported;
      log.success(
        `Imported ${imported} note(s) from ${total} total (${skipped} skipped)`
      );
    });
}
