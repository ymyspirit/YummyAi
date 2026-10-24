import { Injectable } from "@nestjs/common";
import { RedisPodArtworkDispatcher } from "@yummyai/pod-core";

@Injectable()
export class RedisPodArtworkEnqueuer extends RedisPodArtworkDispatcher {}
