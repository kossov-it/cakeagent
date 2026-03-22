import { execFile } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { CakeSettings } from './types.js';

const DATA_DIR = resolve(process.env['DATA_DIR'] || './data');

function tmpPath(ext: string): string {
  return join(tmpdir(), `cakeagent_${randomBytes(6).toString('hex')}.${ext}`);
}

function execAsync(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

/**
 * Speech-to-Text via local whisper-cli (whisper.cpp).
 * Requires: ffmpeg + whisper-cli on PATH, GGML model in data/models/.
 */
export async function transcribeAudio(
  audio: Buffer,
  settings: CakeSettings,
): Promise<string | null> {
  const oggFile = tmpPath('ogg');
  const wavFile = tmpPath('wav');

  try {
    writeFileSync(oggFile, audio);
    await execAsync('ffmpeg', ['-i', oggFile, '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', wavFile]);

    const modelName = settings.voiceSttModel || 'base';
    const modelPath = join(DATA_DIR, 'models', `ggml-${modelName}.bin`);
    if (!existsSync(modelPath)) {
      console.warn(`[voice] Model not found: ${modelPath}`);
      return null;
    }

    // whisper-cli flags: -m model, -f file, -oj JSON output, -of output prefix, -np no prints
    const outPrefix = wavFile.replace(/\.[^.]+$/, '');
    await execAsync('whisper-cli', ['-m', modelPath, '-f', wavFile, '-oj', '-of', outPrefix, '-np']);

    const jsonFile = outPrefix + '.json';
    if (existsSync(jsonFile)) {
      const result = JSON.parse(readFileSync(jsonFile, 'utf-8'));
      const text = result.transcription?.map((s: any) => s.text).join(' ').trim();
      try { unlinkSync(jsonFile); } catch { /* ignore */ }
      return text || null;
    }
    return null;
  } catch (err) {
    console.error('[voice] STT failed:', (err as Error).message);
    return null;
  } finally {
    for (const f of [oggFile, wavFile]) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
  }
}

/**
 * Text-to-Speech via edge-tts (free, no API key).
 * Outputs OGG/OPUS via ffmpeg for Telegram sendVoice compatibility.
 * Requires: `npm i edge-tts` + ffmpeg on PATH.
 */
export async function synthesizeSpeech(
  text: string,
  settings: CakeSettings,
): Promise<Buffer | null> {
  const mp3File = tmpPath('mp3');
  const oggFile = tmpPath('ogg');

  try {
    // edge-tts npm package may have broken main entry — try multiple import paths
    let mod: any = null;
    for (const path of ['edge-tts', 'edge-tts/out/index.js']) {
      mod = await (Function(`return import("${path}")`))().catch(() => null);
      if (mod) break;
    }
    if (!mod) {
      console.warn('[voice] edge-tts not installed. Run: cd /opt/cakeagent && npm i edge-tts');
      return null;
    }

    const voice = settings.voiceTtsVoice || 'en-US-AriaNeural';

    let mp3Written = false;
    if (mod.EdgeTTS) {
      const tts = new mod.EdgeTTS();
      await tts.synthesize(text, voice, { outputFile: mp3File });
      mp3Written = existsSync(mp3File);
    }
    if (!mp3Written && mod.default?.EdgeTTS) {
      const tts = new mod.default.EdgeTTS();
      await tts.synthesize(text, voice, { outputFile: mp3File });
      mp3Written = existsSync(mp3File);
    }
    if (!mp3Written && typeof mod.synthesize === 'function') {
      await mod.synthesize(text, { voice, outputFile: mp3File });
      mp3Written = existsSync(mp3File);
    }
    if (!mp3Written) {
      console.warn('[voice] edge-tts: synthesis failed — check package version');
      return null;
    }

    // Convert MP3 → OGG/OPUS for Telegram voice note compatibility
    await execAsync('ffmpeg', ['-i', mp3File, '-c:a', 'libopus', '-b:a', '48k', '-y', oggFile]);

    if (existsSync(oggFile)) {
      return readFileSync(oggFile);
    }

    // Fallback: return MP3 if ffmpeg conversion fails (won't show as voice bubble)
    return readFileSync(mp3File);
  } catch (err) {
    console.error('[voice] TTS failed:', (err as Error).message);
    return null;
  } finally {
    for (const f of [mp3File, oggFile]) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
  }
}

/**
 * Check voice dependencies at startup. Call this and log warnings.
 */
export async function checkVoiceDeps(): Promise<{ stt: boolean; tts: boolean; missing: string[] }> {
  const missing: string[] = [];
  let stt = false;
  let tts = false;

  try {
    await execAsync('whisper-cli', ['-h']);
    stt = true;
  } catch { missing.push('whisper-cli (install whisper.cpp for STT)'); }

  try {
    await execAsync('ffmpeg', ['-version']);
  } catch { missing.push('ffmpeg (required for audio conversion)'); }

  if (!existsSync(join(DATA_DIR, 'models', 'ggml-base.bin'))) {
    missing.push('whisper model (download from whisper.cpp/models/)');
  }

  try {
    const mod: any = await (Function('return import("edge-tts")')()).catch(() => null);
    if (mod) tts = true;
    else missing.push('edge-tts (run: npm i edge-tts)');
  } catch { missing.push('edge-tts (run: npm i edge-tts)'); }

  return { stt, tts, missing };
}
