"""百炼转写只持久化服务地域，密钥状态供界面展示而不暴露凭据。"""

from enum import StrEnum

from pydantic import BaseModel, Field


class BailianRegion(StrEnum):
    BEIJING = "beijing"
    SINGAPORE = "singapore"


BAILIAN_API_BASE_URLS = {
    BailianRegion.BEIJING: "https://dashscope.aliyuncs.com/api/v1",
    BailianRegion.SINGAPORE: "https://dashscope-intl.aliyuncs.com/api/v1",
}


class BailianAsrConfiguration(BaseModel):
    region: BailianRegion = BailianRegion.BEIJING

    @property
    def base_url(self) -> str:
        return BAILIAN_API_BASE_URLS[self.region]


class BailianAsrPatch(BaseModel):
    region: BailianRegion | None = None
    api_key: str | None = Field(default=None, repr=False)


class BailianAsrStatus(BailianAsrConfiguration):
    api_key_configured: bool


class BailianConnectionResult(BaseModel):
    configured: bool
    message: str
