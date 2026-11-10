import { createHash } from "node:crypto";
import exifr from "exifr";

/* ######################################################################
 * Free, deterministic checks that run before any AI call.
 * Hard flags reject the proof outright; soft flags force human review.
 * ###################################################################### */

export const MAX_PROOF_BYTES = 8 * 1024 * 1024;

export type ProofMimeType = "image/jpeg" | "image/png" | "application/pdf";

export type ExifSummary = {
  takenAt: string | null;
  latitude: number | null;
  longitude: number | null;
  distanceMeters: number | null;
  software: string | null;
};

export type PrecheckResult = {
  mimeType: ProofMimeType | null;
  sha256: string;
  exif: ExifSummary;
  hardFlags: string[];
  softFlags: string[];
};

export type PrecheckInput = {
  bytes: Buffer;
  proofType: "photo" | "document";
  site: { lat: number | null; lng: number | null; radiusMeters: number };
  window: { start: string; end: string };
  isDuplicate: (sha256: string) => boolean;
  note?: string;
};

/** Detects the real file type from magic bytes, never from the name. */
export function sniffMimeType(bytes: Buffer): ProofMimeType | null {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 5 &&
    bytes.subarray(0, 5).toString("latin1") === "%PDF-"
  ) {
    return "application/pdf";
  }
  return null;
}

/** Great-circle distance in metres (haversine). */
export function distanceInMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const earthRadius = 6_371_000;
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.lat)) *
      Math.cos(toRadians(b.lat)) *
      Math.sin(dLng / 2) ** 2;
  return Math.round(2 * earthRadius * Math.asin(Math.sqrt(h)));
}

// Phrases that try to talk to the inspector instead of describing the work.
const INSTRUCTION_PATTERN =
  /\b(ignore (all|previous|the above)|system prompt|you are now|approve (this|the payment)|(always|just|automatically) (approve|release|pay)|set (met|confidence)|return \{)/i;

export function looksLikePromptInjection(text: string | undefined): boolean {
  return Boolean(text && INSTRUCTION_PATTERN.test(text));
}

const EDITING_SOFTWARE =
  /photoshop|gimp|lightroom|snapseed|picsart|canva|midjourney|dall|stable diffusion|firefly/i;

type RawExif = {
  DateTimeOriginal?: Date;
  CreateDate?: Date;
  latitude?: number;
  longitude?: number;
  Software?: string;
};

async function readExif(bytes: Buffer): Promise<RawExif> {
  try {
    return ((await exifr.parse(bytes, { gps: true, tiff: true, exif: true })) ??
      {}) as RawExif;
  } catch {
    return {};
  }
}

export async function runPrechecks(
  input: PrecheckInput,
): Promise<PrecheckResult> {
  const hardFlags: string[] = [];
  const softFlags: string[] = [];
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const mimeType = sniffMimeType(input.bytes);
  const exif: ExifSummary = {
    takenAt: null,
    latitude: null,
    longitude: null,
    distanceMeters: null,
    software: null,
  };

  if (input.bytes.length > MAX_PROOF_BYTES) {
    hardFlags.push("file_too_large");
  }
  if (!mimeType) {
    hardFlags.push("unsupported_file_type");
    return { mimeType, sha256, exif, hardFlags, softFlags };
  }
  if (input.proofType === "photo" && mimeType === "application/pdf") {
    hardFlags.push("photo_required");
  }
  if (input.isDuplicate(sha256)) {
    hardFlags.push("duplicate_proof");
  }
  if (looksLikePromptInjection(input.note)) {
    hardFlags.push("instructions_in_note");
  }

  if (mimeType !== "application/pdf") {
    const raw = await readExif(input.bytes);
    const takenAt = raw.DateTimeOriginal ?? raw.CreateDate;
    exif.takenAt =
      takenAt instanceof Date && !Number.isNaN(takenAt.getTime())
        ? takenAt.toISOString()
        : null;
    exif.software = raw.Software ?? null;
    if (typeof raw.latitude === "number" && typeof raw.longitude === "number") {
      exif.latitude = raw.latitude;
      exif.longitude = raw.longitude;
    }

    if (exif.software && EDITING_SOFTWARE.test(exif.software)) {
      softFlags.push("edited_with_software");
    }

    if (exif.takenAt) {
      const day = exif.takenAt.slice(0, 10);
      if (day < input.window.start || day > input.window.end) {
        softFlags.push("taken_outside_milestone_window");
      }
    } else if (input.proofType === "photo") {
      softFlags.push("no_capture_date");
    }

    if (input.site.lat !== null && input.site.lng !== null) {
      if (exif.latitude !== null && exif.longitude !== null) {
        exif.distanceMeters = distanceInMeters(
          { lat: exif.latitude, lng: exif.longitude },
          { lat: input.site.lat, lng: input.site.lng },
        );
        if (exif.distanceMeters > input.site.radiusMeters) {
          hardFlags.push("taken_away_from_site");
        }
      } else if (input.proofType === "photo") {
        softFlags.push("no_location");
      }
    }
  }

  // A certificate or invoice is easy to forge and carries no camera
  // metadata to cross-check, so the AI may read it but never pays on it.
  if (input.proofType === "document") {
    softFlags.push("document_needs_human_check");
  }

  return { mimeType, sha256, exif, hardFlags, softFlags };
}
