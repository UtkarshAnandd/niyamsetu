import path from "path";
import crypto from "crypto";
import multer from "multer";

// npm scripts run from apps/api, so this is apps/api/uploads/.
export const UPLOAD_DIR = path.resolve(process.cwd(), "uploads");

const ALLOWED: Record<string, string[]> = {
  ".pdf": ["application/pdf"],
  ".png": ["image/png"],
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
};

// Thrown for a wrong file type; the error handler turns it into a 400.
export class UploadError extends Error {}

// Keeps letters, digits, dot, dash and underscore only.
export const cleanFileName = (name: string) => name.replace(/[^a-zA-Z0-9._-]/g, "_");

export const evidenceUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const random = crypto.randomBytes(4).toString("hex");
      cb(null, `${Date.now()}-${random}-${cleanFileName(file.originalname)}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED[ext]?.includes(file.mimetype)) return cb(null, true);
    cb(new UploadError("Only PDF, PNG or JPG files are allowed"));
  },
});
