import { ClassSerializerInterceptor, Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { AllExceptionsFilter } from './filters';
import {
  CorrelationIdInterceptor,
  ResponseEnvelopeInterceptor,
} from './interceptors';

// Order matters: APP_INTERCEPTOR providers apply their pre-handler logic in
// registration order and their response-mapping logic in reverse (the last
// one registered sits closest to the route handler). So: correlation ID
// established first: ClassSerializerInterceptor strips @Exclude'd fields
// from the raw handler result first; ResponseEnvelopeInterceptor wraps the
// already-serialized result last, right before it reaches the client.
@Module({
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: CorrelationIdInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ClassSerializerInterceptor },
  ],
})
export class CommonModule {}
