import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  FileTypeValidator,
  ForbiddenException,
  Get,
  Logger,
  MaxFileSizeValidator,
  NotFoundException,
  Param,
  ParseFilePipe,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Request, Response } from "express";
import { User } from "../auth/types/User";
import { PostgresService } from "../postgres/postgres.service";
import { S3Service } from "../s3/s3.service";
import { isRoleAbove } from "../utilities/isRoleAbove";
import { UtilityRendersService } from "./utility-renders.service";

// Cloudflare caps proxied request bodies at ~100MB, and a lineup clip is
// seconds long, so one direct post is all an upload ever needs.
const VIDEO_MAX_SIZE = 90 * 1024 * 1024;

// The extension rides on the S3 key, which is how a reader of preview_file
// knows what it is holding. A rendered preview is always mp4.
const FORMATS = {
  mp4: "video/mp4",
  webm: "video/webm",
} as const;

type Format = keyof typeof FORMATS;

/**
 * A lineup's video, uploaded by hand. It lands where a rendered preview would
 * (same S3 key, same columns), so everything that plays a preview plays this
 * too and an install without a GPU node still gets clips.
 */
// Under /utility because that is a prefix the API ingress already routes; a
// new top-level path would 404 until the panel's ingress learned it.
@Controller("utility/videos")
export class UtilityVideosController {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly s3: S3Service,
  ) {}

  @Post(":lineupId")
  @UseInterceptors(FileInterceptor("file"))
  public async upload(
    @Req() request: Request,
    @Param("lineupId") lineupId: string,
    @Body() body: { duration_ms?: string },
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: VIDEO_MAX_SIZE }),
          new FileTypeValidator({ fileType: /video\/(mp4|webm)/ }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    const user = this.assertAdmin(request);
    await this.assertLineup(lineupId);

    // The mimetype above is client-claimed; the bytes decide what it is.
    const format = UtilityVideosController.sniff(file.buffer);

    if (!format) {
      throw new BadRequestException("file content does not match its type");
    }

    const durationMs = Number(body?.duration_ms);
    const key = UtilityVideosController.key(lineupId, format);

    await this.s3.put(key, file.buffer, FORMATS[format]);

    // Replacing an mp4 with a webm (or back) leaves the other key orphaned.
    for (const other of Object.keys(FORMATS) as Array<Format>) {
      if (other !== format) {
        await this.removeQuietly(UtilityVideosController.key(lineupId, other));
      }
    }

    // The thumbnail belonged to whatever clip was here before.
    await this.postgres.query(
      `UPDATE public.utility_lineups
          SET preview_file = $2,
              preview_thumbnail = NULL,
              preview_duration_ms = $3::int,
              preview_rendered_at = now()
        WHERE id = $1::uuid`,
      [
        lineupId,
        key,
        Number.isFinite(durationMs) && durationMs > 0
          ? Math.round(durationMs)
          : null,
      ],
    );

    this.logger.log(
      `[utility-video] ${user.steam_id} uploaded ${file.size} bytes for ${lineupId}`,
    );

    return { success: true };
  }

  @Delete(":lineupId")
  public async remove(
    @Req() request: Request,
    @Param("lineupId") lineupId: string,
  ) {
    const user = this.assertAdmin(request);
    await this.assertLineup(lineupId);

    await this.postgres.query(
      `UPDATE public.utility_lineups
          SET preview_file = NULL,
              preview_thumbnail = NULL,
              preview_duration_ms = NULL,
              preview_rendered_at = NULL
        WHERE id = $1::uuid`,
      [lineupId],
    );

    for (const key of [
      ...(Object.keys(FORMATS) as Array<Format>).map((format) =>
        UtilityVideosController.key(lineupId, format),
      ),
      UtilityRendersService.GetPreviewThumbnailS3Key(lineupId),
    ]) {
      await this.removeQuietly(key);
    }

    this.logger.log(`[utility-video] ${user.steam_id} removed ${lineupId}`);

    return { success: true };
  }

  // Where preview_url points when no Cloudflare worker is configured, as
  // <id>.<ext> so the address says what it holds. Range support is not
  // optional: iOS <video> refuses to play a 200-only response.
  @Get(":file")
  public async serve(
    @Param("file") fileName: string,
    @Query("dl") dl: string | undefined,
    @Query("name") name: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const lineupId = String(fileName ?? "").replace(/\.(mp4|webm)$/i, "");

    if (!UtilityVideosController.isUuid(lineupId)) {
      throw new NotFoundException("video not found");
    }

    const [row] = await this.postgres.query<Array<{ preview_file: string }>>(
      `SELECT preview_file
         FROM public.utility_lineups
        WHERE id = $1::uuid AND preview_file IS NOT NULL`,
      [lineupId],
    );

    if (!row) {
      throw new NotFoundException("video not found");
    }

    const key = row.preview_file;

    let size: number;
    try {
      ({ size } = await this.s3.stat(key));
    } catch (error) {
      if ((error as { code?: string })?.code === "NotFound") {
        throw new NotFoundException("video not found");
      }
      this.logger.error(`failed to stat ${key}: ${(error as Error)?.message}`);
      response.status(500).json({ error: "internal" });
      return;
    }

    const format: Format = key.endsWith(".webm") ? "webm" : "mp4";
    const safeName = String(name ?? "").replace(/[^a-zA-Z0-9._-]/g, "");

    response.setHeader("Content-Type", FORMATS[format]);
    if (dl === "1") {
      response.setHeader(
        "Content-Disposition",
        safeName ? `attachment; filename="${safeName}"` : "attachment",
      );
    }
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("X-Content-Type-Options", "nosniff");
    // preview_url carries ?v=<upload time>, so a replaced clip is a new URL.
    response.setHeader("Cache-Control", "public, max-age=2592000, immutable");

    const rangeHeader = request.headers.range;
    const range = rangeHeader
      ? UtilityVideosController.parseRange(rangeHeader, size)
      : null;

    if (rangeHeader && !range) {
      response.setHeader("Content-Range", `bytes */${size}`);
      response.status(416).end();
      return;
    }

    try {
      let stream: NodeJS.ReadableStream;
      if (range) {
        const length = range.end - range.start + 1;
        response.status(206);
        response.setHeader(
          "Content-Range",
          `bytes ${range.start}-${range.end}/${size}`,
        );
        response.setHeader("Content-Length", String(length));
        stream = await this.s3.getPartial(key, range.start, length);
      } else {
        response.status(200);
        response.setHeader("Content-Length", String(size));
        stream = await this.s3.get(key);
      }
      response.on("close", () => {
        (stream as unknown as { destroy?: () => void }).destroy?.();
      });
      stream.pipe(response);
    } catch (error) {
      this.logger.error(`failed to stream ${key}: ${(error as Error)?.message}`);
      if (!response.headersSent) {
        response.status(500).json({ error: "internal" });
      } else {
        response.destroy();
      }
    }
  }

  // mp4 carries "ftyp" at byte 4; webm is EBML, which opens with 1A 45 DF A3.
  private static sniff(buffer: Buffer): Format | null {
    if (buffer.length >= 8 && buffer.subarray(4, 8).toString() === "ftyp") {
      return "mp4";
    }

    if (
      buffer.length >= 4 &&
      buffer[0] === 0x1a &&
      buffer[1] === 0x45 &&
      buffer[2] === 0xdf &&
      buffer[3] === 0xa3
    ) {
      return "webm";
    }

    return null;
  }

  // Same clips/utility/ prefix a rendered preview uses: it is the only one the
  // Cloudflare worker's route patterns match.
  private static key(lineupId: string, format: Format): string {
    return format === "mp4"
      ? UtilityRendersService.GetPreviewS3Key(lineupId)
      : `clips/utility/${lineupId}.webm`;
  }

  private async removeQuietly(key: string): Promise<void> {
    try {
      await this.s3.remove(key);
    } catch (error) {
      this.logger.warn(
        `[utility-video] could not remove ${key}: ${(error as Error)?.message}`,
      );
    }
  }

  private assertAdmin(request: Request): User {
    const user = request.user as User | undefined;

    if (!user || !isRoleAbove(user.role, "administrator")) {
      throw new ForbiddenException("only an administrator can manage videos");
    }

    return user;
  }

  private async assertLineup(lineupId: string): Promise<void> {
    if (!UtilityVideosController.isUuid(lineupId)) {
      throw new NotFoundException("lineup not found");
    }

    const [row] = await this.postgres.query<Array<{ id: string }>>(
      "SELECT id::text AS id FROM public.utility_lineups WHERE id = $1::uuid",
      [lineupId],
    );

    if (!row) {
      throw new NotFoundException("lineup not found");
    }
  }

  private static isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      String(value ?? ""),
    );
  }

  private static parseRange(
    header: string,
    size: number,
  ): { start: number; end: number } | null {
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match) return null;
    const [, startStr, endStr] = match;
    let start: number;
    let end: number;
    if (startStr === "" && endStr === "") return null;
    if (startStr === "") {
      const suffix = parseInt(endStr, 10);
      if (!Number.isFinite(suffix) || suffix <= 0) return null;
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = parseInt(startStr, 10);
      end = endStr === "" ? size - 1 : parseInt(endStr, 10);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (start < 0 || end < start || start >= size) return null;
    if (end >= size) end = size - 1;
    return { start, end };
  }
}
