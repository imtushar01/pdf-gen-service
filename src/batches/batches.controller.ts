/**
 * batches.controller.ts
 *
 * HTTP endpoints for bulk PDF generation.
 *
 * POST /api/v1/batches               → create a batch (202 Accepted)
 * GET  /api/v1/batches/:id           → batch status + per-item progress
 * GET  /api/v1/batches/:id/download  → download the persisted ZIP (Range-aware)
 *
 * The download endpoint reuses the same Range logic as single PDFs so bulk
 * ZIP downloads are resumable over unreliable connections.
 *
 * SOLID — Single Responsibility: HTTP concerns only; orchestration lives in
 * BatchesService, ZIP serving delegates to storage.
 */
import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { Readable } from 'stream';
import { BatchesService } from './batches.service';
import { CreateBatchDto } from '../documents/dto/batch-item-request.dto';
import { BatchResponseDto } from './dto/batch-response.dto';
import { PrismaService } from '../prisma/prisma.service';
import {
  IStorageService,
  STORAGE_SERVICE,
} from '../storage/storage.interface';
import { parseRange } from '../downloads/range.util';

@ApiTags('Batches')
@ApiSecurity('X-API-Key')
@Controller('batches')
export class BatchesController {
  constructor(
    private readonly batchesService: BatchesService,
    private readonly prisma: PrismaService,
    @Inject(STORAGE_SERVICE)
    private readonly storage: IStorageService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Create a bulk PDF generation batch (up to 100 documents)',
    description:
      'Validates all documents, captures an immutable snapshot of each, and ' +
      'queues them for rendering. Returns 202 with a batch ID. Poll the ' +
      'status endpoint for progress; download the ZIP when complete.',
  })
  @ApiResponse({ status: 202, description: 'Batch accepted', type: BatchResponseDto })
  @ApiResponse({ status: 400, description: 'One or more documents invalid' })
  async createBatch(
    @Body() dto: CreateBatchDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BatchResponseDto> {
    const batch = await this.batchesService.createBatch(dto);
    res.status(HttpStatus.ACCEPTED);
    // Freshly created — no items rendered yet; fetch full shape for response
    const full = await this.batchesService.getBatch(batch.id);
    return BatchResponseDto.fromModel(full as never);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get batch status and per-item progress',
  })
  @ApiResponse({ status: 200, type: BatchResponseDto })
  @ApiResponse({ status: 404, description: 'Batch not found' })
  async getBatch(@Param('id') id: string): Promise<BatchResponseDto> {
    const batch = await this.batchesService.getBatch(id);
    return BatchResponseDto.fromModel(batch as never);
  }

  @Get(':id/download')
  @ApiOperation({
    summary: 'Download the batch ZIP (supports HTTP Range / resume)',
    description:
      'Streams the persisted ZIP of all successful PDFs. A failures.json ' +
      'manifest is included in the ZIP if any documents failed. Supports ' +
      'Range requests for resumable downloads. The ZIP is never rebuilt on ' +
      'retry — the same persisted bytes are served.',
  })
  @ApiResponse({ status: 200, description: 'Full ZIP' })
  @ApiResponse({ status: 206, description: 'Partial ZIP (Range request)' })
  @ApiResponse({ status: 404, description: 'Batch or ZIP not ready' })
  @ApiResponse({ status: 416, description: 'Range not satisfiable' })
  async downloadZip(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const zip = await this.prisma.zipArtifact.findUnique({
      where: { batchId: id },
    });
    if (!zip) {
      throw new NotFoundException(
        `ZIP for batch ${id} is not ready. The batch may still be processing.`,
      );
    }

    const size = zip.sizeBytes;
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="batch-${id}.zip"`);
    res.setHeader('X-Checksum-SHA256', zip.sha256);

    const rangeResult = parseRange(req.headers.range, size);

    if (rangeResult.type === 'unsatisfiable') {
      res.setHeader('Content-Range', `bytes */${size}`);
      res.status(HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE).end();
      return;
    }

    if (rangeResult.type === 'satisfiable') {
      const { start, end } = rangeResult;
      res.status(HttpStatus.PARTIAL_CONTENT);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', end - start + 1);
      const stream = await this.storage.createReadStream(zip.storagePath, {
        start,
        end,
      });
      this.pipe(stream, res);
      return;
    }

    res.status(HttpStatus.OK);
    res.setHeader('Content-Length', size);
    const stream = await this.storage.createReadStream(zip.storagePath);
    this.pipe(stream, res);
  }

  private pipe(stream: Readable, res: Response): void {
    stream.on('error', (err: Error) => {
      if (!res.headersSent) res.status(HttpStatus.INTERNAL_SERVER_ERROR);
      res.destroy(err);
    });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }
}
