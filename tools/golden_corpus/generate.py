#!/usr/bin/env python3
import argparse
import json
import math
import os
import random
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Tuple

import numpy as np
import cv2
from PIL import Image, ImageDraw, ImageFont
import imagehash
from pydantic import BaseModel

WIDTH = 2175
HEIGHT = 3075
DPI = 300
MARGIN = 140
BACKGROUND = 245
TEXT_COLOR = (25, 25, 25)


def seed_everything(seed: int) -> np.random.Generator:
    os.environ.setdefault("PYTHONHASHSEED", "0")
    random.seed(seed)
    np.random.seed(seed)
    cv2.setRNGSeed(seed)
    return np.random.default_rng(seed)


def load_font(size: int) -> ImageFont.FreeTypeFont:
    try:
        return ImageFont.truetype("DejaVuSans.ttf", size=size)
    except Exception:
        return ImageFont.load_default()


def new_canvas(width: int, height: int, value: int = BACKGROUND) -> Image.Image:
    arr = np.full((height, width, 3), value, dtype=np.uint8)
    return Image.fromarray(arr, mode="RGB")


def add_paper_texture(img: Image.Image, rng: np.random.Generator, strength: float = 2.0) -> Image.Image:
    arr = np.array(img, dtype=np.float32)
    noise = rng.normal(0, strength, size=arr.shape).astype(np.float32)
    arr = np.clip(arr + noise, 0, 255).astype(np.uint8)
    return Image.fromarray(arr, mode="RGB")


def add_text_block(
    draw: ImageDraw.ImageDraw,
    box: Tuple[int, int, int, int],
    line_height: int,
    rng: np.random.Generator,
    color: Tuple[int, int, int] = TEXT_COLOR,
) -> None:
    x0, y0, x1, y1 = box
    max_width = x1 - x0
    y = y0
    line_index = 0
    while y + line_height <= y1:
        line_len = int(max_width * rng.uniform(0.6, 0.98))
        if line_index % 7 == 0:
            line_len = int(max_width * rng.uniform(0.4, 0.7))
        draw.rectangle([x0, y, x0 + line_len, y + line_height - 6], fill=color)
        y += line_height
        line_index += 1


def draw_running_head(draw: ImageDraw.ImageDraw, width: int, top: int) -> None:
    font = load_font(32)
    text = "ASTERIA STUDIO"
    text_width = draw.textlength(text, font=font)
    draw.text(((width - text_width) / 2, top), text, fill=(40, 40, 40), font=font)


def draw_folio(draw: ImageDraw.ImageDraw, width: int, bottom: int, folio: str) -> None:
    font = load_font(30)
    text_width = draw.textlength(folio, font=font)
    draw.text(((width - text_width) / 2, bottom), folio, fill=(50, 50, 50), font=font)


def apply_shadow_gradient(img: Image.Image, side: str, width: int, min_factor: float) -> Image.Image:
    arr = np.array(img, dtype=np.float32)
    h, w = arr.shape[:2]
    width = max(1, min(width, w))
    if side == "left":
        gradient = np.linspace(min_factor, 1.0, width, dtype=np.float32)
        mask = np.ones((h, w), dtype=np.float32)
        mask[:, :width] = gradient[None, :]
    elif side == "right":
        gradient = np.linspace(1.0, min_factor, width, dtype=np.float32)
        mask = np.ones((h, w), dtype=np.float32)
        mask[:, w - width : w] = gradient[None, :]
    else:
        return img
    arr = np.clip(arr * mask[..., None], 0, 255).astype(np.uint8)
    return Image.fromarray(arr, mode="RGB")


def apply_linear_illumination(img: Image.Image, axis: str, start: float, end: float) -> Image.Image:
    arr = np.array(img, dtype=np.float32)
    h, w = arr.shape[:2]
    if axis == "x":
        gradient = np.linspace(start, end, w, dtype=np.float32)
        mask = gradient[None, :, None]
    else:
        gradient = np.linspace(start, end, h, dtype=np.float32)
        mask = gradient[:, None, None]
    arr = np.clip(arr * mask, 0, 255).astype(np.uint8)
    return Image.fromarray(arr, mode="RGB")


def apply_vignette(img: Image.Image, strength: float = 0.9) -> Image.Image:
    arr = np.array(img, dtype=np.float32)
    h, w = arr.shape[:2]
    y, x = np.ogrid[:h, :w]
    cy, cx = h / 2.0, w / 2.0
    dist = np.sqrt((x - cx) ** 2 + (y - cy) ** 2)
    max_dist = np.sqrt(cx**2 + cy**2)
    mask = 1.0 - (dist / max_dist) * (1.0 - strength)
    mask = np.clip(mask, strength, 1.0)
    arr = np.clip(arr * mask[..., None], 0, 255).astype(np.uint8)
    return Image.fromarray(arr, mode="RGB")


def apply_curved_warp(img: Image.Image, amplitude: float) -> Image.Image:
    arr = np.array(img)
    h, w = arr.shape[:2]
    map_x, map_y = np.meshgrid(np.arange(w), np.arange(h))
    map_y = map_y.astype(np.float32)
    map_x = map_x.astype(np.float32)
    map_y = map_y + amplitude * np.sin(2 * math.pi * map_x / w)
    warped = cv2.remap(arr, map_x, map_y, interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=(255, 255, 255))
    return Image.fromarray(warped, mode="RGB")


def apply_rotation_perspective(img: Image.Image, angle: float) -> Image.Image:
    arr = np.array(img)
    h, w = arr.shape[:2]
    center = (w / 2.0, h / 2.0)
    rot = cv2.getRotationMatrix2D(center, angle, 1.0)
    rotated = cv2.warpAffine(arr, rot, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=(255, 255, 255))
    src = np.float32([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]])
    dst = np.float32([[40, 20], [w - 60, 0], [w - 20, h - 40], [0, h - 10]])
    matrix = cv2.getPerspectiveTransform(src, dst)
    warped = cv2.warpPerspective(rotated, matrix, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=(255, 255, 255))
    return Image.fromarray(warped, mode="RGB")


def apply_rotation(img: Image.Image, angle: float) -> Image.Image:
    arr = np.array(img)
    h, w = arr.shape[:2]
    center = (w / 2.0, h / 2.0)
    rot = cv2.getRotationMatrix2D(center, angle, 1.0)
    rotated = cv2.warpAffine(arr, rot, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=(255, 255, 255))
    return Image.fromarray(rotated, mode="RGB")


def draw_ornament(draw: ImageDraw.ImageDraw, center: Tuple[int, int], size: int) -> Tuple[int, int, int, int]:
    cx, cy = center
    radius = size // 2
    bbox = [cx - radius, cy - radius, cx + radius, cy + radius]
    draw.ellipse(bbox, outline=(20, 20, 20), width=4)
    draw.line([cx - radius, cy, cx + radius, cy], fill=(20, 20, 20), width=3)
    draw.line([cx, cy - radius, cx, cy + radius], fill=(20, 20, 20), width=3)
    return bbox[0], bbox[1], bbox[2], bbox[3]


def draw_title_block(draw: ImageDraw.ImageDraw, box: Tuple[int, int, int, int]) -> None:
    x0, y0, x1, y1 = box
    draw.rectangle([x0, y0, x1, y1], fill=(30, 30, 30))


def draw_drop_cap(draw: ImageDraw.ImageDraw, box: Tuple[int, int, int, int]) -> None:
    x0, y0, x1, y1 = box
    draw.rectangle([x0, y0, x1, y1], fill=(35, 35, 35))


def spread_confidence(image: Image.Image) -> float:
    arr = np.array(image)
    h, w = arr.shape[:2]
    if w == 0 or h == 0:
        return 0.0
    if w / h < 1.25:
        return 0.0
    preview_width = min(320, w)
    scale = preview_width / w
    preview_height = max(1, int(round(h * scale)))
    preview = cv2.resize(arr, (preview_width, preview_height), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(preview, cv2.COLOR_RGB2GRAY)
    column_means = gray.mean(axis=0)
    global_mean = float(column_means.mean())
    center_start = int(preview_width * 0.4)
    center_end = int(preview_width * 0.6)
    min_index = center_start
    min_value = float(column_means[min_index])
    for x in range(center_start, center_end):
        if column_means[x] < min_value:
            min_value = float(column_means[x])
            min_index = x
    darkness = global_mean - min_value
    if darkness < 10:
        return 0.0
    threshold = min_value + darkness * 0.5
    left = min_index
    right = min_index
    while left > 0 and column_means[left] < threshold:
        left -= 1
    while right < preview_width - 1 and column_means[right] < threshold:
        right += 1
    mid = preview_width // 2
    center_distance = abs(min_index - mid) / max(1, mid)
    left_density = column_means[:mid].mean() if mid > 0 else global_mean
    right_density = column_means[mid:].mean() if preview_width - mid > 0 else global_mean
    symmetry = 1 - min(1, abs(left_density - right_density) / max(1, global_mean))
    confidence = max(0.0, min(1.0, (darkness / 35) * 0.6 + symmetry * 0.3 + (1 - center_distance) * 0.1))
    return confidence


class Ornament(BaseModel):
    box: List[int]
    hash: str


class Gutter(BaseModel):
    side: str
    widthPx: int


class BaselineGrid(BaseModel):
    medianSpacingPx: Optional[float]


class TruthPage(BaseModel):
    pageId: str
    pageBoundsPx: List[int]
    contentBoxPx: List[int]
    gutter: Gutter
    baselineGrid: BaselineGrid
    ornaments: List[Ornament]
    shouldSplit: bool
    expectedReviewReasons: List[str]


class ManifestEntry(BaseModel):
    id: str
    description: str
    tags: List[str]
    truthFile: str
    ssimThreshold: float
    ornamentHash: Optional[str] = None


class Manifest(BaseModel):
    version: str
    seed: int
    dpi: int
    imageSizePx: dict
    pages: List[ManifestEntry]


@dataclass
class PageSpec:
    page_id: str
    description: str
    tags: List[str]
    ssim_threshold: float
    renderer: callable


def save_image(img: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, format="PNG", compress_level=6, optimize=False)


def save_json(obj: BaseModel, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = obj.model_dump(exclude_none=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)


def build_clean_single(rng: np.random.Generator, width: int, height: int) -> Tuple[Image.Image, TruthPage, ManifestEntry]:
    img = new_canvas(width, height)
    img = add_paper_texture(img, rng, strength=1.5)
    draw = ImageDraw.Draw(img)
    content = (MARGIN, MARGIN + 40, width - MARGIN, height - MARGIN)
    add_text_block(draw, content, 40, rng)
    truth = TruthPage(
        pageId="p01_clean_single",
        pageBoundsPx=[0, 0, width - 1, height - 1],
        contentBoxPx=list(content),
        gutter=Gutter(side="none", widthPx=0),
        baselineGrid=BaselineGrid(medianSpacingPx=20.08),
        ornaments=[],
        shouldSplit=False,
        expectedReviewReasons=["low-shading-confidence"],
    )
    manifest = ManifestEntry(
        id="p01_clean_single",
        description="clean single column",
        tags=["clean", "single-column"],
        truthFile="p01_clean_single.json",
        ssimThreshold=0.99,
    )
    return img, truth, manifest


def build_clean_double(rng: np.random.Generator, width: int, height: int) -> Tuple[Image.Image, TruthPage, ManifestEntry]:
    img = new_canvas(width, height)
    img = add_paper_texture(img, rng, strength=1.5)
    draw = ImageDraw.Draw(img)
    gap = 80
    column_width = (width - 2 * MARGIN - gap) // 2
    left = (MARGIN, MARGIN + 40, MARGIN + column_width, height - MARGIN)
    right = (MARGIN + column_width + gap, MARGIN + 40, width - MARGIN, height - MARGIN)
    add_text_block(draw, left, 40, rng)
    add_text_block(draw, right, 40, rng)
    content = (MARGIN, MARGIN + 40, width - MARGIN, height - MARGIN)
    truth = TruthPage(
        pageId="p02_clean_double",
        pageBoundsPx=[0, 0, width - 1, height - 1],
        contentBoxPx=list(content),
        gutter=Gutter(side="none", widthPx=0),
        baselineGrid=BaselineGrid(medianSpacingPx=28.67),
        ornaments=[],
        shouldSplit=False,
        expectedReviewReasons=["low-shading-confidence", "residual-skew-*"],
    )
    manifest = ManifestEntry(
        id="p02_clean_double",
        description="clean two column",
        tags=["clean", "double-column"],
        truthFile="p02_clean_double.json",
        ssimThreshold=0.99,
    )
    return img, truth, manifest


def build_running_head(rng: np.random.Generator, width: int, height: int) -> Tuple[Image.Image, TruthPage, ManifestEntry]:
    img = new_canvas(width, height)
    img = add_paper_texture(img, rng, strength=1.8)
    draw = ImageDraw.Draw(img)
    draw_running_head(draw, width, 50)
    draw_folio(draw, width, height - 80, "12")
    content = (MARGIN, MARGIN + 140, width - MARGIN, height - MARGIN - 120)
    add_text_block(draw, content, 40, rng)
    img = apply_linear_illumination(img, "x", 1.0, 0.93)
    img = apply_vignette(img, strength=0.92)
    truth = TruthPage(
        pageId="p03_running_head_folio",
        pageBoundsPx=[0, 0, width - 1, height - 1],
        contentBoxPx=list(content),
        gutter=Gutter(side="none", widthPx=0),
        baselineGrid=BaselineGrid(medianSpacingPx=18.71),
        ornaments=[],
        shouldSplit=False,
        expectedReviewReasons=["low-shading-confidence", "residual-skew-*"],
    )
    manifest = ManifestEntry(
        id="p03_running_head_folio",
        description="running head and folio bands",
        tags=["running-head", "folio"],
        truthFile="p03_running_head_folio.json",
        ssimThreshold=0.99,
    )
    return img, truth, manifest


def build_ornament(rng: np.random.Generator, width: int, height: int) -> Tuple[Image.Image, TruthPage, ManifestEntry]:
    img = new_canvas(width, height)
    img = add_paper_texture(img, rng, strength=1.5)
    draw = ImageDraw.Draw(img)
    ornament_box = draw_ornament(draw, (width // 2, MARGIN + 120), 120)
    content = (MARGIN, MARGIN + 220, width - MARGIN, height - MARGIN)
    add_text_block(draw, content, 40, rng)
    ornament_crop = img.crop(ornament_box)
    ornament_hash = str(imagehash.phash(ornament_crop))
    truth = TruthPage(
        pageId="p04_ornament",
        pageBoundsPx=[0, 0, width - 1, height - 1],
        contentBoxPx=list(content),
        gutter=Gutter(side="none", widthPx=0),
        baselineGrid=BaselineGrid(medianSpacingPx=16.85),
        ornaments=[Ornament(box=list(ornament_box), hash=ornament_hash)],
        shouldSplit=False,
        expectedReviewReasons=["low-shading-confidence", "residual-skew-*"],
    )
    manifest = ManifestEntry(
        id="p04_ornament",
        description="ornament page",
        tags=["ornament"],
        truthFile="p04_ornament.json",
        ssimThreshold=0.99,
        ornamentHash=ornament_hash,
    )
    return img, truth, manifest


def build_footnotes_marginalia(rng: np.random.Generator, width: int, height: int) -> Tuple[Image.Image, TruthPage, ManifestEntry]:
    img = new_canvas(width, height)
    img = add_paper_texture(img, rng, strength=1.7)
    draw = ImageDraw.Draw(img)
    content = (MARGIN + 80, MARGIN + 40, width - MARGIN, height - MARGIN - 220)
    add_text_block(draw, content, 38, rng)
    footnotes = (MARGIN + 80, height - MARGIN - 180, width - MARGIN, height - MARGIN)
    add_text_block(draw, footnotes, 28, rng)
    marginalia = (MARGIN - 90, MARGIN + 200, MARGIN + 40, height - MARGIN - 300)
    add_text_block(draw, marginalia, 30, rng)
    truth = TruthPage(
        pageId="p05_footnotes_marginalia",
        pageBoundsPx=[0, 0, width - 1, height - 1],
        contentBoxPx=[MARGIN - 90, MARGIN + 40, width - MARGIN, height - MARGIN],
        gutter=Gutter(side="none", widthPx=0),
        baselineGrid=BaselineGrid(medianSpacingPx=25.76),
        ornaments=[],
        shouldSplit=False,
        expectedReviewReasons=["low-shading-confidence", "residual-skew-*"],
    )
    manifest = ManifestEntry(
        id="p05_footnotes_marginalia",
        description="footnotes and marginalia",
        tags=["footnotes", "marginalia"],
        truthFile="p05_footnotes_marginalia.json",
        ssimThreshold=0.99,
    )
    return img, truth, manifest


def build_blank_verso(rng: np.random.Generator, width: int, height: int) -> Tuple[Image.Image, TruthPage, ManifestEntry]:
    img = new_canvas(width, height, value=248)
    img = add_paper_texture(img, rng, strength=1.0)
    truth = TruthPage(
        pageId="p06_blank_verso",
        pageBoundsPx=[0, 0, width - 1, height - 1],
        contentBoxPx=[MARGIN, MARGIN, width - MARGIN, height - MARGIN],
        gutter=Gutter(side="none", widthPx=0),
        baselineGrid=BaselineGrid(medianSpacingPx=None),
        ornaments=[],
        shouldSplit=False,
        expectedReviewReasons=["low-skew-confidence", "low-shading-confidence", "residual-skew-*"],
    )
    manifest = ManifestEntry(
        id="p06_blank_verso",
        description="blank verso",
        tags=["blank"],
        truthFile="p06_blank_verso.json",
        ssimThreshold=0.99,
    )
    return img, truth, manifest


def build_plate(rng: np.random.Generator, width: int, height: int) -> Tuple[Image.Image, TruthPage, ManifestEntry]:
    img = new_canvas(width, height)
    img = add_paper_texture(img, rng, strength=1.3)
    draw = ImageDraw.Draw(img)
    plate_box = (MARGIN + 100, MARGIN + 200, width - MARGIN - 100, height - MARGIN - 300)
    draw.rectangle(plate_box, outline=(20, 20, 20), width=4)
    gradient = np.tile(np.linspace(200, 240, plate_box[2] - plate_box[0], dtype=np.uint8), (plate_box[3] - plate_box[1], 1))
    gradient_img = np.stack([gradient] * 3, axis=2)
    plate = Image.fromarray(gradient_img, mode="RGB")
    img.paste(plate, plate_box[:2])
    truth = TruthPage(
        pageId="p07_plate",
        pageBoundsPx=[0, 0, width - 1, height - 1],
        contentBoxPx=list(plate_box),
        gutter=Gutter(side="none", widthPx=0),
        baselineGrid=BaselineGrid(medianSpacingPx=None),
        ornaments=[],
        shouldSplit=False,
        expectedReviewReasons=["low-skew-confidence", "low-shading-confidence"],
    )
    manifest = ManifestEntry(
        id="p07_plate",
        description="illustration plate",
        tags=["illustration", "plate"],
        truthFile="p07_plate.json",
        ssimThreshold=0.99,
    )
    return img, truth, manifest


def build_shadow_page(
    rng: np.random.Generator,
    width: int,
    height: int,
    side: str,
    page_id: str,
    baseline_spacing: float,
) -> Tuple[Image.Image, TruthPage, ManifestEntry]:
    img = new_canvas(width, height)
    img = add_paper_texture(img, rng, strength=1.6)
    draw = ImageDraw.Draw(img)
    content = (MARGIN, MARGIN + 40, width - MARGIN, height - MARGIN)
    add_text_block(draw, content, 40, rng)
    img = apply_shadow_gradient(img, side, width=140, min_factor=0.55)
    img = apply_linear_illumination(img, "x", 0.95, 1.0)
    truth = TruthPage(
        pageId=page_id,
        pageBoundsPx=[0, 0, width - 1, height - 1],
        contentBoxPx=list(content),
        gutter=Gutter(side=side, widthPx=140),
        baselineGrid=BaselineGrid(medianSpacingPx=baseline_spacing),
        ornaments=[],
        shouldSplit=False,
        expectedReviewReasons=["low-shading-confidence", "residual-skew-*"],
    )
    manifest = ManifestEntry(
        id=page_id,
        description=f"{side} gutter shadow",
        tags=["shadow", f"gutter-{side}"],
        truthFile=f"{page_id}.json",
        ssimThreshold=0.985,
    )
    return img, truth, manifest


def build_spread(rng: np.random.Generator) -> Tuple[Image.Image, TruthPage, ManifestEntry]:
    width = WIDTH * 2
    height = HEIGHT
    img = new_canvas(width, height)
    img = add_paper_texture(img, rng, strength=1.4)
    draw = ImageDraw.Draw(img)
    gutter_width = 220
    left_box = (MARGIN, MARGIN + 40, WIDTH - MARGIN - gutter_width // 2, height - MARGIN)
    right_box = (WIDTH + gutter_width // 2 + MARGIN, MARGIN + 40, width - MARGIN, height - MARGIN)
    add_text_block(draw, left_box, 40, rng)
    add_text_block(draw, right_box, 40, rng)

    gutter_start = WIDTH - gutter_width // 2
    gutter_end = WIDTH + gutter_width // 2
    gutter_color = 225
    for attempt in range(6):
        overlay = Image.new("RGB", (width, height), (BACKGROUND, BACKGROUND, BACKGROUND))
        overlay_arr = np.array(overlay)
        overlay_arr[:, gutter_start:gutter_end, :] = gutter_color
        overlay = Image.fromarray(overlay_arr, mode="RGB")
        composite = Image.blend(img, overlay, alpha=0.4)
        confidence = spread_confidence(composite)
        if 0.6 <= confidence < 0.7:
            img = composite
            break
        gutter_color = max(200, min(240, gutter_color + (2 if confidence < 0.6 else -3)))
        img = composite

    truth = TruthPage(
        pageId="p10_spread_dark_gutter",
        pageBoundsPx=[0, 0, width - 1, height - 1],
        contentBoxPx=[MARGIN, MARGIN, width - MARGIN, height - MARGIN],
        gutter=Gutter(side="center", widthPx=gutter_width),
        baselineGrid=BaselineGrid(medianSpacingPx=22.83),
        ornaments=[],
        shouldSplit=True,
        expectedReviewReasons=[
            "low-shading-confidence",
            "residual-skew-*",
            "spread-split-low-confidence",
        ],
    )
    manifest = ManifestEntry(
        id="p10_spread_dark_gutter",
        description="two-page spread with dark gutter",
        tags=["spread", "gutter"],
        truthFile="p10_spread_dark_gutter.json",
        ssimThreshold=0.985,
    )
    return img, truth, manifest


def build_curved_warp(rng: np.random.Generator) -> Tuple[Image.Image, TruthPage, ManifestEntry]:
    img = new_canvas(WIDTH, HEIGHT)
    img = add_paper_texture(img, rng, strength=1.5)
    draw = ImageDraw.Draw(img)
    content = (MARGIN, MARGIN + 40, WIDTH - MARGIN, HEIGHT - MARGIN)
    add_text_block(draw, content, 44, rng)
    img = apply_curved_warp(img, amplitude=20)
    truth = TruthPage(
        pageId="p11_curved_warp",
        pageBoundsPx=[0, 0, WIDTH - 1, HEIGHT - 1],
        contentBoxPx=list(content),
        gutter=Gutter(side="none", widthPx=0),
        baselineGrid=BaselineGrid(medianSpacingPx=34.85),
        ornaments=[],
        shouldSplit=False,
        expectedReviewReasons=["low-shading-confidence", "residual-skew-*"],
    )
    manifest = ManifestEntry(
        id="p11_curved_warp",
        description="curved warp baseline",
        tags=["warp", "baseline"],
        truthFile="p11_curved_warp.json",
        ssimThreshold=0.985,
    )
    return img, truth, manifest


def build_rotation_perspective(rng: np.random.Generator) -> Tuple[Image.Image, TruthPage, ManifestEntry]:
    img = new_canvas(WIDTH, HEIGHT)
    img = add_paper_texture(img, rng, strength=1.5)
    draw = ImageDraw.Draw(img)
    content = (MARGIN, MARGIN + 40, WIDTH - MARGIN, HEIGHT - MARGIN)
    add_text_block(draw, content, 40, rng)
    img = apply_rotation_perspective(img, angle=3.5)
    truth = TruthPage(
        pageId="p12_rot_perspective",
        pageBoundsPx=[0, 0, WIDTH - 1, HEIGHT - 1],
        contentBoxPx=list(content),
        gutter=Gutter(side="none", widthPx=0),
        baselineGrid=BaselineGrid(medianSpacingPx=23.86),
        ornaments=[],
        shouldSplit=False,
        expectedReviewReasons=["low-shading-confidence", "residual-skew-*"],
    )
    manifest = ManifestEntry(
        id="p12_rot_perspective",
        description="rotation + perspective warp",
        tags=["warp", "perspective"],
        truthFile="p12_rot_perspective.json",
        ssimThreshold=0.985,
    )
    return img, truth, manifest


def build_rotation_only(rng: np.random.Generator) -> Tuple[Image.Image, TruthPage, ManifestEntry]:
    img = new_canvas(WIDTH, HEIGHT)
    img = add_paper_texture(img, rng, strength=1.6)
    draw = ImageDraw.Draw(img)
    content = (MARGIN, MARGIN + 40, WIDTH - MARGIN, HEIGHT - MARGIN)
    add_text_block(draw, content, 40, rng)
    img = apply_rotation(img, angle=-2.8)
    truth = TruthPage(
        pageId="p13_rotation_only",
        pageBoundsPx=[0, 0, WIDTH - 1, HEIGHT - 1],
        contentBoxPx=list(content),
        gutter=Gutter(side="none", widthPx=0),
        baselineGrid=BaselineGrid(medianSpacingPx=24.11),
        ornaments=[],
        shouldSplit=False,
        expectedReviewReasons=["low-shading-confidence", "residual-skew-*"],
    )
    manifest = ManifestEntry(
        id="p13_rotation_only",
        description="rotation only",
        tags=["rotation", "skew"],
        truthFile="p13_rotation_only.json",
        ssimThreshold=0.985,
    )
    return img, truth, manifest


def build_spread_light_gutter(rng: np.random.Generator) -> Tuple[Image.Image, TruthPage, ManifestEntry]:
    width = WIDTH * 2
    height = HEIGHT
    img = new_canvas(width, height)
    img = add_paper_texture(img, rng, strength=1.5)
    draw = ImageDraw.Draw(img)
    gutter_width = 160
    left_box = (MARGIN, MARGIN + 40, WIDTH - MARGIN - gutter_width // 2, height - MARGIN)
    right_box = (WIDTH + gutter_width // 2 + MARGIN, MARGIN + 40, width - MARGIN, height - MARGIN)
    add_text_block(draw, left_box, 40, rng)
    add_text_block(draw, right_box, 40, rng)

    gutter_start = WIDTH - gutter_width // 2
    gutter_end = WIDTH + gutter_width // 2
    gutter_color = 232
    for _attempt in range(5):
        overlay = Image.new("RGB", (width, height), (BACKGROUND, BACKGROUND, BACKGROUND))
        overlay_arr = np.array(overlay)
        overlay_arr[:, gutter_start:gutter_end, :] = gutter_color
        overlay = Image.fromarray(overlay_arr, mode="RGB")
        composite = Image.blend(img, overlay, alpha=0.3)
        confidence = spread_confidence(composite)
        img = composite
        if 0.45 <= confidence < 0.58:
            break
        gutter_color = max(210, min(240, gutter_color + (2 if confidence < 0.45 else -2)))

    truth = TruthPage(
        pageId="p14_spread_light_gutter",
        pageBoundsPx=[0, 0, width - 1, height - 1],
        contentBoxPx=[MARGIN, MARGIN, width - MARGIN, height - MARGIN],
        gutter=Gutter(side="center", widthPx=gutter_width),
        baselineGrid=BaselineGrid(medianSpacingPx=21.44),
        ornaments=[],
        shouldSplit=True,
        expectedReviewReasons=[
            "low-shading-confidence",
            "residual-skew-*",
            "spread-split-low-confidence",
        ],
    )
    manifest = ManifestEntry(
        id="p14_spread_light_gutter",
        description="two-page spread with light gutter",
        tags=["spread", "gutter", "split"],
        truthFile="p14_spread_light_gutter.json",
        ssimThreshold=0.98,
    )
    return img, truth, manifest


def build_crop_adjustment(rng: np.random.Generator) -> Tuple[Image.Image, TruthPage, ManifestEntry]:
    img = new_canvas(WIDTH, HEIGHT)
    img = add_paper_texture(img, rng, strength=1.9)
    draw = ImageDraw.Draw(img)
    content = (MARGIN - 40, MARGIN + 10, WIDTH - MARGIN + 30, HEIGHT - MARGIN + 10)
    add_text_block(draw, content, 38, rng)
    trim_box = (MARGIN - 70, MARGIN - 30, WIDTH - MARGIN + 60, HEIGHT - MARGIN + 60)
    draw.rectangle(trim_box, outline=(15, 15, 15), width=4)
    img = apply_linear_illumination(img, "y", 1.02, 0.92)
    truth = TruthPage(
        pageId="p15_crop_adjustment",
        pageBoundsPx=[0, 0, WIDTH - 1, HEIGHT - 1],
        contentBoxPx=[MARGIN - 70, MARGIN - 30, WIDTH - MARGIN + 60, HEIGHT - MARGIN + 60],
        gutter=Gutter(side="none", widthPx=0),
        baselineGrid=BaselineGrid(medianSpacingPx=27.35),
        ornaments=[],
        shouldSplit=False,
        expectedReviewReasons=["low-shading-confidence", "residual-skew-*"],
    )
    manifest = ManifestEntry(
        id="p15_crop_adjustment",
        description="crop adjustment stress",
        tags=["crop", "adjustment"],
        truthFile="p15_crop_adjustment.json",
        ssimThreshold=0.985,
    )
    return img, truth, manifest


def build_overlay_element_classes(rng: np.random.Generator) -> Tuple[Image.Image, TruthPage, ManifestEntry]:
    img = new_canvas(WIDTH, HEIGHT)
    img = add_paper_texture(img, rng, strength=1.6)
    draw = ImageDraw.Draw(img)
    draw_running_head(draw, WIDTH, 50)
    draw_folio(draw, WIDTH, HEIGHT - 80, "247")
    draw_ornament(draw, (WIDTH // 2, MARGIN + 140), 110)
    title_box = (MARGIN + 120, MARGIN + 40, WIDTH - MARGIN - 120, MARGIN + 120)
    draw_title_block(draw, title_box)
    drop_cap_box = (MARGIN + 30, MARGIN + 200, MARGIN + 120, MARGIN + 320)
    draw_drop_cap(draw, drop_cap_box)
    content = (MARGIN + 140, MARGIN + 180, WIDTH - MARGIN, HEIGHT - MARGIN - 200)
    add_text_block(draw, content, 36, rng)
    footnotes = (MARGIN + 120, HEIGHT - MARGIN - 170, WIDTH - MARGIN, HEIGHT - MARGIN)
    add_text_block(draw, footnotes, 26, rng)
    marginalia = (MARGIN - 90, MARGIN + 260, MARGIN + 20, HEIGHT - MARGIN - 320)
    add_text_block(draw, marginalia, 28, rng)
    truth = TruthPage(
        pageId="p16_overlay_elements",
        pageBoundsPx=[0, 0, WIDTH - 1, HEIGHT - 1],
        contentBoxPx=[MARGIN - 90, MARGIN + 40, WIDTH - MARGIN, HEIGHT - MARGIN],
        gutter=Gutter(side="none", widthPx=0),
        baselineGrid=BaselineGrid(medianSpacingPx=23.02),
        ornaments=[],
        shouldSplit=False,
        expectedReviewReasons=["low-shading-confidence", "residual-skew-*"],
    )
    manifest = ManifestEntry(
        id="p16_overlay_elements",
        description="overlay element class showcase",
        tags=["overlay", "elements", "title", "drop-cap", "marginalia", "footnotes", "ornament"],
        truthFile="p16_overlay_elements.json",
        ssimThreshold=0.985,
    )
    return img, truth, manifest


def build_pages(rng: np.random.Generator) -> List[Tuple[Image.Image, TruthPage, ManifestEntry]]:
    pages: List[Tuple[Image.Image, TruthPage, ManifestEntry]] = []
    img, truth, manifest = build_clean_single(rng, WIDTH, HEIGHT)
    pages.append((img, truth, manifest))
    img, truth, manifest = build_clean_double(rng, WIDTH, HEIGHT)
    pages.append((img, truth, manifest))
    img, truth, manifest = build_running_head(rng, WIDTH, HEIGHT)
    pages.append((img, truth, manifest))
    img, truth, manifest = build_ornament(rng, WIDTH, HEIGHT)
    pages.append((img, truth, manifest))
    img, truth, manifest = build_footnotes_marginalia(rng, WIDTH, HEIGHT)
    pages.append((img, truth, manifest))
    img, truth, manifest = build_blank_verso(rng, WIDTH, HEIGHT)
    pages.append((img, truth, manifest))
    img, truth, manifest = build_plate(rng, WIDTH, HEIGHT)
    pages.append((img, truth, manifest))
    img, truth, manifest = build_shadow_page(
        rng,
        WIDTH,
        HEIGHT,
        "left",
        "p08_shadow_left",
        21.16,
    )
    pages.append((img, truth, manifest))
    img, truth, manifest = build_shadow_page(
        rng,
        WIDTH,
        HEIGHT,
        "right",
        "p09_shadow_right",
        25.58,
    )
    pages.append((img, truth, manifest))
    img, truth, manifest = build_spread(rng)
    pages.append((img, truth, manifest))
    img, truth, manifest = build_curved_warp(rng)
    pages.append((img, truth, manifest))
    img, truth, manifest = build_rotation_perspective(rng)
    pages.append((img, truth, manifest))
    img, truth, manifest = build_rotation_only(rng)
    pages.append((img, truth, manifest))
    img, truth, manifest = build_spread_light_gutter(rng)
    pages.append((img, truth, manifest))
    img, truth, manifest = build_crop_adjustment(rng)
    pages.append((img, truth, manifest))
    img, truth, manifest = build_overlay_element_classes(rng)
    pages.append((img, truth, manifest))

    return pages


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate golden corpus v1")
    parser.add_argument("--seed", type=int, default=1337)
    parser.add_argument("--out", type=str, required=True)
    args = parser.parse_args()

    rng = seed_everything(args.seed)

    out_root = Path(args.out)
    inputs_dir = out_root / "inputs"
    truth_dir = out_root / "truth"
    expected_dir = out_root / "expected"
    inputs_dir.mkdir(parents=True, exist_ok=True)
    truth_dir.mkdir(parents=True, exist_ok=True)
    expected_dir.mkdir(parents=True, exist_ok=True)

    pages = build_pages(rng)

    for img, truth, entry in pages:
        img_path = inputs_dir / f"{truth.pageId}.png"
        save_image(img, img_path)
        truth_path = truth_dir / entry.truthFile
        save_json(truth, truth_path)

    manifest = Manifest(
        version="1",
        seed=args.seed,
        dpi=DPI,
        imageSizePx={"width": WIDTH, "height": HEIGHT},
        pages=[entry for _img, _truth, entry in pages],
    )
    manifest_path = out_root / "manifest.json"
    save_json(manifest, manifest_path)

    print(f"Golden corpus written to {out_root}")


if __name__ == "__main__":
    main()
