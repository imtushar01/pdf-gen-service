/**
 * renderer.module.ts
 *
 * Provides the renderer and template services to the application.
 * Imported by the worker module (M7) where rendering actually happens.
 */
import { Module } from '@nestjs/common';
import { RendererService } from './renderer.service';
import { TemplateService } from './template.service';

@Module({
  providers: [RendererService, TemplateService],
  exports: [RendererService, TemplateService],
})
export class RendererModule {}
