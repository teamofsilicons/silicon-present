//! Layer commands use the same stable selection, group and lock rules as the web editor.

use crate::args::{LayerDirection, LayersArgs, LayersCmd};
use crate::ctx::{Ctx, to_value};
use crate::fail::{Fail, R};
use serde_json::{Value, json};
use silicon_present_client::deck;
use silicon_present_client::ops::{EditRequest, Op, ZTarget};
use std::collections::HashSet;

#[derive(Debug)]
pub enum Destination {
    Direction(LayerDirection),
    Before(String),
    After(String),
}

#[derive(Clone, Debug)]
struct Layer {
    id: String,
    group: Option<String>,
    locked: bool,
}

impl Layer {
    fn from_value(element: &Value) -> Self {
        Self {
            id: deck::str_field(element, "id")
                .unwrap_or_default()
                .to_owned(),
            group: deck::str_field(element, "group")
                .filter(|group| !group.is_empty())
                .map(str::to_owned),
            locked: element
                .get("locked")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }
    }
}

pub async fn run(ctx: &Ctx, args: &LayersArgs) -> R<()> {
    match &args.sub {
        Some(LayersCmd::Move(args)) => {
            let destination = match (args.to, &args.before, &args.after) {
                (Some(direction), None, None) => Destination::Direction(direction),
                (None, Some(target), None) => Destination::Before(target.clone()),
                (None, None, Some(target)) => Destination::After(target.clone()),
                _ => {
                    return Err(Fail::new(
                        "invalid_input",
                        "Choose one layer destination.",
                        "Use --to front|back|forward|backward, --before ELEMENT or --after ELEMENT.",
                    ));
                }
            };
            move_layers(ctx, &args.deck, &args.slide, &args.elements, destination).await
        }
        None => {
            list(
                ctx,
                args.deck.as_deref().unwrap_or_default(),
                args.slide.as_deref().unwrap_or_default(),
            )
            .await
        }
    }
}

async fn list(ctx: &Ctx, reference: &str, slide: &str) -> R<()> {
    let client = ctx.maybe_authed().await?;
    let id = ctx.deck_id(&client, reference).await?;
    let content = client.content(&id, None).await?;
    let sid = ctx.slide_id(&content, slide)?;
    let slide = deck::slide_by_id(&content, &sid).expect("resolved slide");
    let layers: Vec<Value> = deck::elements(slide).iter().enumerate().rev().map(|(index, element)| {
        let layer = Layer::from_value(element);
        let kind = deck::str_field(element, "kind").unwrap_or("element");
        let text = deck::plain_text(element.get("text").unwrap_or(&Value::Null));
        let label = if text.trim().is_empty() {
            deck::str_field(element, "alt")
                .or_else(|| deck::str_field(element, "shape"))
                .unwrap_or(kind).to_owned()
        } else { text.split_whitespace().collect::<Vec<_>>().join(" ") };
        json!({"id":layer.id,"kind":kind,"z":index + 1,"group":layer.group,"locked":layer.locked,"label":label.chars().take(100).collect::<String>()})
    }).collect();
    let result = json!({"deck":id,"slide":sid,"version":content["version"],"order":"front-to-back","layers":layers});
    ctx.out(&result, || {
        let mut lines = vec![format!("Layers on {sid}, front first (z 1 = back):")];
        for layer in &layers {
            let group = layer["group"]
                .as_str()
                .map(|group| format!("  group={group}"))
                .unwrap_or_default();
            let locked = if layer["locked"] == true {
                "  locked"
            } else {
                ""
            };
            lines.push(format!(
                "{:>3}  {}  {:<8} {}{group}{locked}",
                layer["z"],
                layer["id"].as_str().unwrap_or_default(),
                layer["kind"].as_str().unwrap_or_default(),
                layer["label"].as_str().unwrap_or_default()
            ));
        }
        if layers.is_empty() {
            lines.push("No layers on this slide.".into());
        }
        lines.join("\n")
    });
    Ok(())
}

pub async fn move_layers(
    ctx: &Ctx,
    reference: &str,
    slide: &str,
    selectors: &[String],
    destination: Destination,
) -> R<()> {
    let client = ctx.authed().await?;
    let id = ctx.deck_id(&client, reference).await?;
    let content = client.content(&id, None).await?;
    let sid = ctx.slide_id(&content, slide)?;
    let resolve = |selector: &str| -> R<String> {
        Ok(
            deck::str_field(ctx.element(&content, &sid, selector)?, "id")
                .unwrap_or_default()
                .to_owned(),
        )
    };
    // Resolve every positional selector against one snapshot, before any ordering changes.
    let selected = selectors
        .iter()
        .map(|selector| resolve(selector))
        .collect::<R<Vec<_>>>()?;
    let destination = match destination {
        Destination::Before(target) => Destination::Before(resolve(&target)?),
        Destination::After(target) => Destination::After(resolve(&target)?),
        destination => destination,
    };
    let layers: Vec<_> = deck::elements(deck::slide_by_id(&content, &sid).expect("resolved slide"))
        .iter()
        .map(Layer::from_value)
        .collect();
    let moving = movable_selection(&layers, &selected);
    let skipped: Vec<_> = selected.iter().filter(|id| !moving.contains(*id)).collect();
    let order = target_order(&layers, &selected, &destination);
    let ops = plan_ops(&sid, &layers, &moving, &order, &destination);
    let descriptions: Vec<_> = ops.iter().map(Op::describe).collect();
    let mut result = json!({"deck":id,"slide":sid,"version":content["version"],"changed":false,"moved":[],"skipped":skipped,"ops":descriptions,"order":"back-to-front","elements":order});
    if !ops.is_empty() {
        let version = content["version"].as_u64().ok_or_else(|| {
            Fail::new(
                "invalid_response",
                "The deck response has no version; its layer order cannot be edited safely.",
                "Read the deck again, then retry.",
            )
        })?;
        let changed = client
            .edit(
                &id,
                &EditRequest::new(ops)
                    .on(version)
                    .summary("Reordered layers"),
            )
            .await?;
        let response = to_value(&changed);
        result["version"] = response["version"].clone();
        result["changed"] = response["changed"].clone();
        result["moved"] = json!(
            layers
                .iter()
                .filter(|layer| moving.contains(&layer.id))
                .map(|layer| &layer.id)
                .collect::<Vec<_>>()
        );
    }
    ctx.out(&result, || {
        let message = if result["changed"] == true {
            format!(
                "Moved layers on {sid}. Now at version {}.",
                result["version"]
            )
        } else {
            format!("Layer order on {sid} is unchanged.")
        };
        if skipped.is_empty() {
            message
        } else {
            format!(
                "{message}\nSkipped locked objects or groups: {}.",
                skipped
                    .iter()
                    .map(|id| id.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }
    });
    Ok(())
}

fn movable_selection(layers: &[Layer], selected: &[String]) -> HashSet<String> {
    let groups: HashSet<_> = layers
        .iter()
        .filter(|layer| selected.contains(&layer.id))
        .filter_map(|layer| layer.group.as_ref())
        .collect();
    let locked_groups: HashSet<_> = layers
        .iter()
        .filter(|layer| layer.locked)
        .filter_map(|layer| layer.group.as_ref())
        .collect();
    layers
        .iter()
        .filter(|layer| {
            !layer.locked
                && !layer
                    .group
                    .as_ref()
                    .is_some_and(|group| locked_groups.contains(group))
                && (selected.contains(&layer.id)
                    || layer
                        .group
                        .as_ref()
                        .is_some_and(|group| groups.contains(group)))
        })
        .map(|layer| layer.id.clone())
        .collect()
}

fn target_order(layers: &[Layer], selected: &[String], destination: &Destination) -> Vec<String> {
    let original = || {
        layers
            .iter()
            .map(|layer| layer.id.clone())
            .collect::<Vec<_>>()
    };
    let moving = movable_selection(layers, selected);
    match destination {
        Destination::Before(target) | Destination::After(target) => {
            let Some(target) = layers.iter().find(|layer| layer.id == *target) else {
                return original();
            };
            if selected.contains(&target.id)
                || target.group.as_ref().is_some_and(|group| {
                    layers.iter().any(|layer| {
                        layer.group.as_ref() == Some(group) && selected.contains(&layer.id)
                    })
                })
            {
                return original();
            }
            let rest: Vec<_> = layers
                .iter()
                .filter(|layer| !moving.contains(&layer.id))
                .collect();
            let target_indexes: Vec<_> = rest
                .iter()
                .enumerate()
                .filter(|(_, layer)| {
                    layer.id == target.id || target.group.is_some() && layer.group == target.group
                })
                .map(|(index, _)| index)
                .collect();
            let at = if matches!(destination, Destination::Before(_)) {
                target_indexes.last().unwrap() + 1
            } else {
                target_indexes[0]
            };
            let mut order: Vec<_> = rest.iter().map(|layer| layer.id.clone()).collect();
            order.splice(
                at..at,
                layers
                    .iter()
                    .filter(|layer| moving.contains(&layer.id))
                    .map(|layer| layer.id.clone()),
            );
            order
        }
        Destination::Direction(direction) => {
            if matches!(direction, LayerDirection::Front | LayerDirection::Back) {
                let mut selected: Vec<_> = layers
                    .iter()
                    .filter(|layer| moving.contains(&layer.id))
                    .map(|layer| layer.id.clone())
                    .collect();
                let mut rest: Vec<_> = layers
                    .iter()
                    .filter(|layer| !moving.contains(&layer.id))
                    .map(|layer| layer.id.clone())
                    .collect();
                return if *direction == LayerDirection::Front {
                    rest.append(&mut selected);
                    rest
                } else {
                    selected.append(&mut rest);
                    selected
                };
            }
            let mut stack: Vec<_> = layers.iter().collect();
            if *direction == LayerDirection::Backward {
                stack.reverse();
            }
            let mut end = stack.len().saturating_sub(1);
            while end > 0 {
                end -= 1;
                if !moving.contains(&stack[end].id) || moving.contains(&stack[end + 1].id) {
                    continue;
                }
                let mut start = end;
                while start > 0 && moving.contains(&stack[start - 1].id) {
                    start -= 1;
                }
                let mut neighbor_end = end + 1;
                let group = &stack[neighbor_end].group;
                while group.is_some()
                    && neighbor_end + 1 < stack.len()
                    && stack[neighbor_end + 1].group == *group
                    && !moving.contains(&stack[neighbor_end + 1].id)
                {
                    neighbor_end += 1;
                }
                stack[start..=neighbor_end].rotate_left(end - start + 1);
                end = start;
            }
            if *direction == LayerDirection::Backward {
                stack.reverse();
            }
            stack.iter().map(|layer| layer.id.clone()).collect()
        }
    }
}

fn plan_ops(
    slide: &str,
    layers: &[Layer],
    moving: &HashSet<String>,
    target: &[String],
    destination: &Destination,
) -> Vec<Op> {
    let mut current: Vec<_> = layers.iter().map(|layer| layer.id.clone()).collect();
    if current == target {
        return vec![];
    }
    let mut ops = Vec::new();
    let relative = matches!(destination, Destination::Before(_) | Destination::After(_));
    let mut sequence = if relative {
        layers
            .iter()
            .filter(|layer| moving.contains(&layer.id))
            .map(|layer| layer.id.clone())
            .collect::<Vec<_>>()
    } else {
        target.to_vec()
    };
    let anchor = if relative {
        target
            .get(target.iter().position(|id| moving.contains(id)).unwrap() + moving.len())
            .cloned()
    } else {
        None
    };
    if matches!(
        destination,
        Destination::Direction(LayerDirection::Front | LayerDirection::Forward)
    ) {
        sequence.reverse();
    }
    for id in sequence {
        if !moving.contains(&id) {
            continue;
        }
        let from = current
            .iter()
            .position(|candidate| candidate == &id)
            .unwrap();
        let to = if relative {
            let before = anchor.as_ref().map_or(current.len(), |anchor| {
                current
                    .iter()
                    .position(|candidate| candidate == anchor)
                    .unwrap()
            });
            before - usize::from(from < before)
        } else {
            target
                .iter()
                .position(|candidate| candidate == &id)
                .unwrap()
        };
        if from == to {
            continue;
        }
        ops.push(Op::ReorderElement {
            slide: slide.to_owned(),
            element: id.clone(),
            to: ZTarget::Index(to as u64),
        });
        current.remove(from);
        current.insert(to, id);
    }
    debug_assert_eq!(current, target);
    ops
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layers(ids: &str) -> Vec<Layer> {
        ids.chars()
            .map(|id| Layer {
                id: id.to_string(),
                group: None,
                locked: false,
            })
            .collect()
    }
    fn selection(ids: &str) -> Vec<String> {
        ids.chars().map(|id| id.to_string()).collect()
    }
    fn order(layers: &[Layer], selected: &str, destination: Destination) -> String {
        target_order(layers, &selection(selected), &destination).join("")
    }
    fn direction(direction: LayerDirection) -> Destination {
        Destination::Direction(direction)
    }

    #[test]
    fn stable_runs_and_stack_boundaries() {
        let layers = layers("abcde");
        for (to, expected) in [
            (LayerDirection::Front, "acebd"),
            (LayerDirection::Back, "bdace"),
            (LayerDirection::Forward, "acbed"),
            (LayerDirection::Backward, "badce"),
        ] {
            assert_eq!(order(&layers, "db", direction(to)), expected);
        }
        assert_eq!(
            order(&layers, "de", direction(LayerDirection::Forward)),
            "abcde"
        );
        assert_eq!(
            order(&layers, "ab", direction(LayerDirection::Backward)),
            "abcde"
        );
        assert_eq!(
            order(&layers, "bc", direction(LayerDirection::Forward)),
            "adbce"
        );
    }

    #[test]
    fn source_and_target_groups_stay_together() {
        let mut layers = layers("abcde");
        layers[1].group = Some("g".into());
        layers[2].group = Some("g".into());
        assert_eq!(
            order(&layers, "b", direction(LayerDirection::Front)),
            "adebc"
        );
        assert_eq!(
            order(&layers, "a", direction(LayerDirection::Forward)),
            "bcade"
        );
        assert_eq!(
            order(&layers, "e", Destination::Before("b".into())),
            "abced"
        );
        assert_eq!(order(&layers, "e", Destination::After("c".into())), "aebcd");
        assert_eq!(
            order(&layers, "b", Destination::Before("c".into())),
            "abcde"
        );
        // Older generic edits may have interleaved a target group: use its whole boundary.
        layers[2].group = None;
        layers[3].group = Some("g".into());
        assert_eq!(
            order(&layers, "e", Destination::Before("b".into())),
            "abcde"
        );
        assert_eq!(order(&layers, "e", Destination::After("d".into())), "aebcd");
    }

    #[test]
    fn locks_protect_whole_groups_but_independent_unlocked_selection_can_move() {
        let mut layers = layers("abcde");
        layers[1].group = Some("g".into());
        layers[2].group = Some("g".into());
        layers[2].locked = true;
        layers[3].locked = true;
        assert_eq!(
            order(&layers, "b", direction(LayerDirection::Front)),
            "abcde"
        );
        assert_eq!(
            order(&layers, "abd", direction(LayerDirection::Front)),
            "bcdea"
        );
        assert_eq!(
            order(&layers, "a", Destination::Before("c".into())),
            "bcade"
        );
    }

    #[test]
    fn numeric_ops_realize_every_small_selection_without_touching_other_objects() {
        let mut grouped = layers("abcde");
        grouped[1].group = Some("g".into());
        grouped[2].group = Some("g".into());
        let mut locked = grouped.clone();
        locked[1].locked = true;
        locked[4].locked = true;
        let mut interleaved = grouped.clone();
        interleaved[2].group = None;
        interleaved[3].group = Some("g".into());
        for layers in [layers("abcde"), grouped, locked, interleaved] {
            for mask in 0..32 {
                let selected: Vec<_> = layers
                    .iter()
                    .enumerate()
                    .filter(|(index, _)| mask & (1 << index) != 0)
                    .map(|(_, layer)| layer.id.clone())
                    .collect();
                let mut destinations: Vec<_> = [
                    LayerDirection::Front,
                    LayerDirection::Back,
                    LayerDirection::Forward,
                    LayerDirection::Backward,
                ]
                .into_iter()
                .map(direction)
                .collect();
                for layer in &layers {
                    destinations.push(Destination::Before(layer.id.clone()));
                    destinations.push(Destination::After(layer.id.clone()));
                }
                for destination in destinations {
                    let moving = movable_selection(&layers, &selected);
                    let target = target_order(&layers, &selected, &destination);
                    let ops = plan_ops("slide", &layers, &moving, &target, &destination);
                    let mut actual: Vec<_> = layers.iter().map(|layer| layer.id.clone()).collect();
                    for op in ops {
                        let Op::ReorderElement {
                            element,
                            to: ZTarget::Index(to),
                            ..
                        } = op
                        else {
                            panic!("unexpected op")
                        };
                        assert!(moving.contains(&element));
                        let from = actual.iter().position(|id| id == &element).unwrap();
                        actual.remove(from);
                        actual.insert(to as usize, element);
                    }
                    assert_eq!(actual, target, "{selected:?} {destination:?}");
                    for keep_selected in [true, false] {
                        let original: Vec<_> = layers
                            .iter()
                            .filter(|layer| moving.contains(&layer.id) == keep_selected)
                            .map(|layer| &layer.id)
                            .collect();
                        let reordered: Vec<_> = target
                            .iter()
                            .filter(|id| moving.contains(*id) == keep_selected)
                            .collect();
                        assert_eq!(original, reordered);
                    }
                }
            }
        }
    }
}
