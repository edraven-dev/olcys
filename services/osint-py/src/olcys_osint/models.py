"""Request and response models of the HTTP API (JSON Schemas are generated from them into ``schemas/``)."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

SCHEMA_VERSION = "usernames-search.v1"

Tag = Literal["crypto", "finance", "pl", "social", "coding", "messaging"]
Status = Literal["found", "not_found", "blocked", "login_wall", "captcha", "unknown", "illegal", "skipped"]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class UsernameSearchRequest(Strict):
    username: str = Field(max_length=64, pattern=r"^[^\s/?#@:]+$")
    database: Literal["fixture", "upstream"]
    deniedHostSuffixes: list[str] = Field(default_factory=list, max_length=200)
    tags: list[Tag] | None = None
    timeoutSeconds: float = Field(default=10, ge=1, le=30)


class ServiceInfo(Strict):
    version: str
    maigretVersion: str
    socidExtractorVersion: str
    python: str


class DatabaseInfo(Strict):
    id: str
    sha256: str
    sitesTotal: int
    sitesSelected: int
    excludedByPolicy: int


class PolicyInfo(Strict):
    version: str
    allowExternal: bool
    tags: list[str]
    userAgent: str


class SiteResult(Strict):
    site: str
    platform: str
    tags: list[str]
    profileUrl: str
    status: Status
    reason: str | None
    httpStatus: int | None
    requestIds: list[str]
    ids: dict[str, str]
    idsLinks: list[str]


class RequestRecord(Strict):
    id: str
    method: Literal["GET"]
    url: str
    logicalUrl: str
    host: str
    site: str
    purpose: str
    containsIdentifier: bool
    allowed: bool
    denyReason: str | None
    requestedAt: str
    receivedAt: str | None
    httpStatus: int | None
    responseHeaders: dict[str, str]
    bodySha256: str | None
    bodyBase64: str | None
    bodyTruncated: bool
    userAgent: str
    error: str | None = None


class UsernameSearchResponse(Strict):
    schemaVersion: Literal["usernames-search.v1"] = SCHEMA_VERSION
    service: ServiceInfo
    username: str
    database: DatabaseInfo
    policy: PolicyInfo
    startedAt: str
    finishedAt: str
    results: list[SiteResult]
    requests: list[RequestRecord]
    summary: dict[str, int]


class ProfileExtractRequest(Strict):
    html: str = Field(max_length=2_000_000)
    url: str = Field(max_length=2048)


class ProfileExtractResponse(Strict):
    ids: dict[str, str]
    idsLinks: list[str]


class ErrorBody(Strict):
    code: str
    message: str
