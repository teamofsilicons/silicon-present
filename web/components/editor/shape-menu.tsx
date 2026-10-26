"use client";

import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { ChevronDown, ChevronRight, ImagePlus, Shapes } from "lucide-react";
import { SHAPES, type ShapeName } from "@silicon-present/deck";
import { shapeGeometry } from "@silicon-present/render";
import { keyLabel } from "@/lib/editor/keys";
import { ToolButton } from "./controls";
import arc from "@/components/arc/dropdown-menu/dropdown-menu.module.css";
import styles from "./shape-menu.module.css";

export const SHAPE_NAMES: Record<ShapeName, string> = {
  rect: "Rectangle", "round-rect": "Rounded rectangle", ellipse: "Ellipse",
  triangle: "Triangle", "right-triangle": "Right triangle", diamond: "Diamond",
  pentagon: "Pentagon", hexagon: "Hexagon", octagon: "Octagon", star: "Star",
  "arrow-right": "Arrow right", "arrow-left": "Arrow left", "arrow-up": "Arrow up", "arrow-down": "Arrow down",
  chevron: "Chevron", line: "Line", callout: "Callout", heart: "Heart", cloud: "Cloud", plus: "Plus",
};

export function ShapeGlyph({ shape, size = 20 }: { shape: string; size?: number }) {
  const height = shape === "line" ? size : Math.round(size * 0.78);
  const geometry = shapeGeometry(shape, size, height);
  return <svg width={size} height={height} viewBox={`-1 -1 ${size + 2} ${height + 2}`} aria-hidden="true">
    <path d={geometry.d} fill={geometry.open ? "none" : "currentColor"} fillOpacity={0.14} stroke="currentColor" strokeWidth={1.4} strokeLinejoin="round" />
  </svg>;
}

const COMMON: { shape: ShapeName; label: string; shortcut?: string }[] = [
  { shape: "rect", label: "Rectangle", shortcut: "R" },
  { shape: "line", label: "Line", shortcut: "L" },
  { shape: "arrow-right", label: "Arrow", shortcut: "Shift+L" },
  { shape: "ellipse", label: "Ellipse", shortcut: "O" },
  { shape: "pentagon", label: "Polygon" },
  { shape: "star", label: "Star" },
];
const MORE = SHAPES.filter(shape => !COMMON.some(item => item.shape === shape));

export function ShapeMenu({ shape, armed, onArm, onMedia }: { shape: ShapeName; armed: boolean; onArm: (shape: ShapeName) => void; onMedia: () => void }) {
  const shapeItem = (choice: ShapeName, label: string, shortcut?: string) => <Dropdown.Item key={choice} className={`${arc.item} ${styles.item}`} data-sq="surface" data-shape={choice} data-current={choice === shape || undefined} textValue={label} onSelect={() => onArm(choice)}>
    <span className={styles.icon}><ShapeGlyph shape={choice} /></span>
    <span className={styles.label}>{label}</span>
    {shortcut ? <span className={styles.shortcut} aria-hidden="true">{keyLabel(shortcut)}</span> : null}
  </Dropdown.Item>;
  return <Dropdown.Root modal={false}>
    <div className={styles.split} role="group" aria-label="Shape tools">
      <ToolButton label={SHAPE_NAMES[shape]} shortcut={COMMON.find(item => item.shape === shape)?.shortcut} active={armed} onClick={() => onArm(shape)} data-testid="insert-shape">
        <ShapeGlyph shape={shape} size={19} />
      </ToolButton>
    <Dropdown.Trigger asChild>
      <ToolButton label="Choose shape" className={styles.trigger} data-testid="choose-shape">
        <ChevronDown size={12} aria-hidden="true" />
      </ToolButton>
    </Dropdown.Trigger>
    </div>
    <Dropdown.Portal>
      <Dropdown.Content className={`${arc.menu} ${styles.menu}`} data-sq="surface" side="top" align="start" sideOffset={8} collisionPadding={12} loop aria-label="Choose shape">
        {COMMON.map(item => shapeItem(item.shape, item.label, item.shortcut))}
        <Dropdown.Sub>
          <Dropdown.SubTrigger className={`${arc.item} ${styles.item}`} data-sq="surface">
            <span className={styles.icon}><Shapes size={18} aria-hidden="true" /></span>
            <span className={styles.label}>More shapes</span><ChevronRight size={15} aria-hidden="true" />
          </Dropdown.SubTrigger>
          <Dropdown.Portal>
            <Dropdown.SubContent className={`${arc.menu} ${styles.menu}`} data-sq="surface" sideOffset={6} alignOffset={-5} collisionPadding={12} loop aria-label="More shapes">
              {MORE.map(shape => shapeItem(shape, SHAPE_NAMES[shape]))}
            </Dropdown.SubContent>
          </Dropdown.Portal>
        </Dropdown.Sub>
        <Dropdown.Separator className={arc.separator} />
        <Dropdown.Item className={`${arc.item} ${styles.item}`} data-sq="surface" onSelect={onMedia}>
          <span className={styles.icon}><ImagePlus size={19} aria-hidden="true" /></span>
          <span className={styles.label}>Image/video</span>
          <span className={styles.shortcut} aria-hidden="true">{keyLabel("Mod+Shift+K")}</span>
        </Dropdown.Item>
      </Dropdown.Content>
    </Dropdown.Portal>
  </Dropdown.Root>;
}
