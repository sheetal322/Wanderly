import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'wanderly:isPublic';

/**
 * Opts a route out of the global auth guard. Authentication is the default, so
 * forgetting a decorator fails closed rather than open.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);
