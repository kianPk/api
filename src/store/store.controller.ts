import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UploadedFile,
  UseInterceptors,
  ParseFilePipe,
  MaxFileSizeValidator,
  FileTypeValidator,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Request, Response } from "express";
import { User } from "../auth/types/User";
import { StoreService } from "./store.service";
import { timingSafeStringEqual } from "../utilities/timingSafeStringEqual";

@Controller("store")
export class StoreController {
  constructor(private readonly store: StoreService) {}

  @Get("status")
  public async status() {
    return this.store.getPublicStatus();
  }

  @Post("upload-image")
  @UseInterceptors(FileInterceptor("file"))
  public async uploadImage(
    @Req() request: Request,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 5 * 1024 * 1024 }),
          new FileTypeValidator({ fileType: /image\/(png|jpeg|webp|gif)/ }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    this.requireAdmin(request);
    const filename = await this.store.uploadProductImage(
      file.buffer,
      file.mimetype,
    );
    return { success: true, filename };
  }

  @Get("image/:filename")
  public async serveImage(
    @Param("filename") filename: string,
    @Res() res: Response,
  ) {
    const result = await this.store.getProductImageStream(filename);
    if (!result) {
      throw new NotFoundException("Image not found");
    }
    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    if (result.etag) {
      res.setHeader("ETag", result.etag);
    }
    result.stream.pipe(res);
  }

  @Post("checkout")
  public async checkout(
    @Req() request: Request,
    @Body()
    body: {
      productId?: string;
      productIds?: string[];
      termsAccepted?: boolean;
    },
  ) {
    const user = this.requireUser(request);
    const ids = [
      ...(Array.isArray(body?.productIds) ? body.productIds : []),
      ...(body?.productId ? [body.productId] : []),
    ];
    if (!ids.length) {
      throw new BadRequestException("productId or productIds required");
    }
    return this.store.checkoutCart(ids, user.steam_id, {
      termsAccepted: Boolean(body?.termsAccepted),
    });
  }

  @Post("cancel-pending")
  public async cancelPending(
    @Req() request: Request,
    @Body() body: { exceptOrderId?: string },
  ) {
    const user = this.requireUser(request);
    return this.store.cancelPendingOrders(user.steam_id, body?.exceptOrderId);
  }

  @Post("bale-webhook")
  public async baleWebhook(
    @Headers("x-bale-webhook-secret") secretHeader: string | undefined,
    @Body() body: any,
  ) {
    const webhookSecret = await this.store.getWebhookSecret();
    if (webhookSecret) {
      const ok = timingSafeStringEqual(secretHeader || "", webhookSecret);
      if (!ok) {
        throw new UnauthorizedException("Invalid webhook secret");
      }
    }
    return this.store.handleWebhookUpdate(body);
  }

  private requireUser(request: Request): User {
    const user = request.user as User | undefined;
    if (!user?.steam_id) {
      throw new UnauthorizedException("Authentication required");
    }
    return user;
  }

  private requireAdmin(request: Request) {
    const user = request.user as User | undefined;
    if (!user?.steam_id) {
      throw new ForbiddenException("Authentication required");
    }
    if (user.role !== "administrator") {
      throw new ForbiddenException("Administrator access required");
    }
  }
}
