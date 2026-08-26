"""虚拟文件夹的业务契约与资料库清单。"""

from datetime import UTC, datetime

from pydantic import BaseModel, Field, field_validator


FOLDER_MANIFEST_FORMAT_VERSION = 1
FOLDER_NAME_MAX_LENGTH = 100
SOURCE_TITLE_SEPARATOR_TRANSLATION = str.maketrans({"/": "／", "\\": "＼"})


def folder_name_from_source_title(source_title: str) -> str:
    """远端合集标题需转换路径分隔符并限长，才能安全用于自动分类。"""
    normalized = source_title.translate(SOURCE_TITLE_SEPARATOR_TRANSLATION).strip()
    return normalized[:FOLDER_NAME_MAX_LENGTH].rstrip()


class Folder(BaseModel):
    """虚拟文件夹只表达分类关系，避免分类操作改变真实素材路径。"""

    folder_id: str
    name: str = Field(min_length=1, max_length=FOLDER_NAME_MAX_LENGTH)
    parent_id: str | None = None
    materialized_path: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    @field_validator("name")
    @classmethod
    def normalize_name(cls, name: str) -> str:
        normalized = name.strip()
        if not normalized:
            raise ValueError("文件夹名称不能为空")
        if "/" in normalized or "\\" in normalized:
            raise ValueError("文件夹名称不能包含路径分隔符")
        return normalized


class FolderManifest(BaseModel):
    format_version: int = FOLDER_MANIFEST_FORMAT_VERSION
    folders: list[Folder] = Field(default_factory=list)


class FolderResponse(Folder):
    direct_asset_count: int
    recursive_asset_count: int
