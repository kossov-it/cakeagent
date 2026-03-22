import { execFile } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { CakeSettings } from './types.js';

let DATA_DIR = '';
const WHISPER_LOCAL = resolve('whisper.cpp/build/bin/whisper-cli');
const EDGE_TTS_LOCAL = '/opt/cakeagent/.local/bin/edge-tts';

export function initVoice(dataDir: string): void {
  DATA_DIR = dataDir;
}

function whisperBin(): string {
  return existsSync(WHISPER_LOCAL) ? WHISPER_LOCAL : 'whisper-cli';
}

function edgeTtsBin(): string {
  return existsSync(EDGE_TTS_LOCAL) ? EDGE_TTS_LOCAL : 'edge-tts';
}

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

    const outPrefix = wavFile.replace(/\.[^.]+$/, '');
    await execAsync(whisperBin(), ['-m', modelPath, '-f', wavFile, '-oj', '-of', outPrefix, '-np']);

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

export async function synthesizeSpeech(
  text: string,
  settings: CakeSettings,
): Promise<Buffer | null> {
  const mp3File = tmpPath('mp3');
  const oggFile = tmpPath('ogg');

  try {
    const voice = settings.voiceTtsVoice || 'en-US-AriaNeural';
    const bin = edgeTtsBin();
    console.log(`[voice] TTS: ${bin} --voice ${voice} --write-media ${mp3File}`);
    await execAsync(bin, ['--voice', voice, '--text', text, '--write-media', mp3File]);

    if (!existsSync(mp3File)) {
      console.warn('[voice] edge-tts produced no output');
      return null;
    }
    console.log(`[voice] TTS: mp3 generated (${readFileSync(mp3File).length} bytes)`);

    await execAsync('ffmpeg', ['-i', mp3File, '-c:a', 'libopus', '-b:a', '48k', '-y', oggFile]);
    return existsSync(oggFile) ? readFileSync(oggFile) : readFileSync(mp3File);
  } catch (err) {
    console.error('[voice] TTS failed:', (err as Error).message);
    return null;
  } finally {
    for (const f of [mp3File, oggFile]) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
  }
}

export async function checkVoiceDeps(): Promise<{ stt: boolean; tts: boolean; missing: string[] }> {
  const missing: string[] = [];
  let stt = false;
  let tts = false;

  try {
    await execAsync(whisperBin(), ['-h']);
    stt = true;
  } catch { missing.push('whisper-cli (install whisper.cpp for STT)'); }

  try {
    await execAsync('ffmpeg', ['-version']);
  } catch { missing.push('ffmpeg (required for audio conversion)'); }

  if (!existsSync(join(DATA_DIR, 'models', 'ggml-base.bin'))) {
    missing.push('whisper model (download from whisper.cpp/models/)');
  }

  try {
    await execAsync(edgeTtsBin(), ['--version']);
    tts = true;
  } catch { missing.push('edge-tts (run: pip3 install edge-tts)'); }

  return { stt, tts, missing };
}
