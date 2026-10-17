/**
 * jobs.controller.ts
 *
 * HTTP endpoints for single-document job management.
 *
 * POST /api/v1/jobs      → create a job (202 Accepted or 200 if existing)
 * GET  /api/v1/jobs/:id  → fetch job status
 *
 * Why 202 Accepted for creation?
 * The job is accepted but not yet complete — rendering happens asynchronously
 * in a worker (M7). 202 signals "I've accepted your request, poll for status."
 * When we return an existing job (idempotent retry), we use 200 OK instead
 * because nothing new was created.
 *
 * SOLID — Single Responsibility: the controller handles HTTP concerns only —
 * parsing the request, setting status codes, shaping the response. All
 * business logic lives in JobsService.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { JobsService } from './jobs.service';
import { CreateJobDto } from '../documents/dto/create-job.dto';
import { JobResponseDto } from './dto/job-response.dto';

@ApiTags('Jobs')
@ApiSecurity('X-API-Key')
@Controller('jobs')
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  @Post()
  @ApiOperation({
    summary: 'Create a single-document PDF generation job',
    description:
      'Validates the document, captures an immutable snapshot, and queues ' +
      'the job for rendering. Returns 202 Accepted with a job ID. ' +
      'If the idempotency key matches an existing job with the same payload, ' +
      'returns 200 OK with the existing job (no duplicate created). ' +
      'If the key was used with a different payload, returns 409 Conflict.',
  })
  @ApiResponse({ status: 202, description: 'Job accepted and queued', type: JobResponseDto })
  @ApiResponse({ status: 200, description: 'Existing job returned (idempotent retry)', type: JobResponseDto })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  @ApiResponse({ status: 409, description: 'Idempotency key reused with different payload' })
  async createJob(
    @Body() dto: CreateJobDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<JobResponseDto> {
    const { job, isExisting } = await this.jobsService.createJob(dto);

    // 200 for existing (idempotent retry), 202 for newly created
    res.status(isExisting ? HttpStatus.OK : HttpStatus.ACCEPTED);

    return JobResponseDto.fromModel(job);
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get job status',
    description: 'Returns the current status and metadata for a job.',
  })
  @ApiResponse({ status: 200, description: 'Job found', type: JobResponseDto })
  @ApiResponse({ status: 404, description: 'Job not found' })
  async getJob(@Param('id') id: string): Promise<JobResponseDto> {
    const job = await this.jobsService.getJob(id);
    return JobResponseDto.fromModel(job);
  }
}
