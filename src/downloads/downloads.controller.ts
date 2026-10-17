/**
 * downloads.controller.ts
 *
 * Serves generated PDF artifacts with HTTP Range (resumable download) support.
 *
 * GET /api/v1/jobs/:id/download   → download the PDF (supports Range)
 * GET /api/v1/jobs/:id/checksum   → return stored checksum + verification
 *
 * ── Resumable downloads ────────────────────────────────────────────────────
 * We always send `Accept-Ranges: bytes` so clients know they can resume.
 * If the client sends a Range header, we serve 206 Partial Content with the
 * requested byte range. Byte offsets are stable because we serve the
 * persisted artifact — we never regenerate the PDF on a retried download.
 *
 * ── Stream error handling ──────────────────────────────────────────────────
 * The file is streamed (piped) to the response, not buffered into memory.
 * If the read stream errors mid-transfer, we destroy the response so the
 * client sees a broken connection rather than a silently truncated file
 * that looks complete.
 *
 * SOLID — Single Responsibility: this controller only serves downloads.
 * It depends on ArtifactService (metadata) and IStorageService (bytes).
 */
import {
  Controller,
  Get,
  Header,
  HttpStatus,
  NotFoundException,
  Param,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { Inject } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Readable } from 'stream';
import { ArtifactService } from '../artifacts/artifact.service';
import {
  IStorageService,
  STORAGE_SERVICE,
} from '../storage/storage.interface';
import { JobsService } from '../jobs/jobs.service';
import { parseRange } from './range.util';

@ApiTags('Downloads')
@ApiSecurity('X-API-Key')
@Controller('jobs')
export class DownloadsController {
  constructor(
    private readonly jobsService: JobsService,
    private readonly artifactService: ArtifactService,
    @Inject(STORAGE_SERVICE)
    private readonly storage: IStorageService,
  ) {}

  @Get(':id/download')
  @ApiOperation({
    summary: 'Download a generated PDF (supports HTTP Range / resume)',
    description:
      'Streams the persisted PDF artifact. Supports HTTP Range requests ' +
      'for resumable downloads over unreliable connections. The PDF is ' +
      'never regenerated — the same stored bytes are served on every retry.',
  })
  @ApiResponse({ status: 200, description: 'Full PDF' })
  @ApiResponse({ status: 206, description: 'Partial PDF (Range request)' })
  @ApiResponse({ status: 404, description: 'Job or artifact not found' })
  @ApiResponse({ status: 416, description: 'Range not satisfiable' })
  async download(
    @Param('id') jobId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // Ensure the job exists (404 otherwise)
    await this.jobsService.getJob(jobId);

    const artifact = await this.artifactService.getByJobId(jobId);
    if (!artifact) {
      throw new NotFoundException(
        `No PDF artifact exists for job ${jobId}. The job may still be processing.`,
      );
    }

    const size = artifact.sizeBytes;
    const filename = `${jobId}.pdf`;

    // Common headers for both full and partial responses
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', artifact.mimeType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`,
    );
    // Expose the stored checksum so clients can verify integrity
    res.setHeader('X-Checksum-SHA256', artifact.sha256);

    const rangeResult = parseRange(req.headers.range, size);

    if (rangeResult.type === 'unsatisfiable') {
      // RFC 7233: 416 must include Content-Range with the full size
      res.setHeader('Content-Range', `bytes */${size}`);
      res.status(HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE).end();
      return;
    }

    if (rangeResult.type === 'satisfiable') {
      const { start, end } = rangeResult;
      const chunkSize = end - start + 1;

      res.status(HttpStatus.PARTIAL_CONTENT);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', chunkSize);

      const stream = await this.storage.createReadStream(
        artifact.storagePath,
        { start, end },
      );
      this.pipeWithErrorHandling(stream, res);
      return;
    }

    // 'full' or 'invalid' (malformed Range is ignored → full file)
    res.status(HttpStatus.OK);
    res.setHeader('Content-Length', size);
    const stream = await this.storage.createReadStream(artifact.storagePath);
    this.pipeWithErrorHandling(stream, res);
  }

  @Get(':id/checksum')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Get and verify the PDF checksum',
    description:
      'Returns the stored SHA-256 checksum and re-computes it from the ' +
      'stored file to confirm integrity (tamper evidence).',
  })
  @ApiResponse({ status: 200, description: 'Checksum and verification result' })
  @ApiResponse({ status: 404, description: 'Job or artifact not found' })
  async checksum(@Param('id') jobId: string): Promise<{
    jobId: string;
    sha256: string;
    sizeBytes: number;
    verified: boolean;
  }> {
    await this.jobsService.getJob(jobId);

    const artifact = await this.artifactService.getByJobId(jobId);
    if (!artifact) {
      throw new NotFoundException(`No PDF artifact exists for job ${jobId}`);
    }

    const verification = await this.artifactService.verifyChecksum(jobId);

    return {
      jobId,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
      verified: verification.valid,
    };
  }

  /**
   * Pipe a read stream to the response with proper error handling.
   * If the source stream errors mid-transfer, destroy the response so the
   * client sees a failed connection rather than a silently truncated file.
   */
  private pipeWithErrorHandling(stream: Readable, res: Response): void {
    stream.on('error', (err: Error) => {
      // If headers are already sent, we can't change the status — just
      // destroy the connection so the client knows the transfer failed.
      if (!res.headersSent) {
        res.status(HttpStatus.INTERNAL_SERVER_ERROR);
      }
      res.destroy(err);
    });

    // If the client disconnects, stop reading to free resources
    res.on('close', () => {
      stream.destroy();
    });

    stream.pipe(res);
  }
}
