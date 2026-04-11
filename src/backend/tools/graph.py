"""Neo4j knowledge graph service for CerebraLink.

Manages two graph domains:
  1. Patient History — episodes, diagnoses, medications, doctors, facilities
  2. Reports — report types, PACS studies, lab tests/values, findings

Nodes and relationships are ingested when patient data or reports are loaded.
Query endpoints return ReactFlow-compatible {nodes, edges} structures.

Falls back gracefully when Neo4j is not available (optional dependency).
"""

from __future__ import annotations

import logging
import time
from typing import Any

from src.backend.core.config import settings

log = logging.getLogger("cerebralink.graph")

# ── Neo4j driver (lazy init, optional) ──

_driver = None
_driver_checked = False


def _get_driver():
    """Get or create the Neo4j async driver. Returns None if unavailable."""
    global _driver, _driver_checked
    if _driver is not None:
        return _driver
    if _driver_checked:
        return None
    _driver_checked = True
    try:
        from neo4j import GraphDatabase
        uri = settings.neo4j_uri
        auth_str = settings.neo4j_auth
        if "/" in auth_str:
            user, password = auth_str.split("/", 1)
        else:
            user, password = "neo4j", auth_str
        _driver = GraphDatabase.driver(uri, auth=(user, password))
        # Verify connectivity
        _driver.verify_connectivity()
        log.info("Neo4j connected: %s", uri)
        return _driver
    except Exception as e:
        log.warning("Neo4j not available: %s — graph features disabled", e)
        _driver = None
        return None


def neo4j_available() -> bool:
    """Check if Neo4j is connected and available."""
    return _get_driver() is not None


# ── Schema constraints (run once) ──

_schema_initialized = False


def _ensure_schema():
    """Create indexes and constraints if not already done."""
    global _schema_initialized
    if _schema_initialized:
        return
    driver = _get_driver()
    if not driver:
        return
    try:
        with driver.session() as session:
            constraints = [
                "CREATE CONSTRAINT IF NOT EXISTS FOR (p:Patient) REQUIRE p.patient_id IS UNIQUE",
                "CREATE CONSTRAINT IF NOT EXISTS FOR (e:Episode) REQUIRE e.episode_id IS UNIQUE",
                "CREATE CONSTRAINT IF NOT EXISTS FOR (r:Report) REQUIRE r.report_id IS UNIQUE",
                "CREATE INDEX IF NOT EXISTS FOR (d:Diagnosis) ON (d.icd_code)",
                "CREATE INDEX IF NOT EXISTS FOR (rt:ReportType) ON (rt.name)",
                "CREATE INDEX IF NOT EXISTS FOR (lt:LabTest) ON (lt.name)",
                "CREATE INDEX IF NOT EXISTS FOR (f:Facility) ON (f.name)",
                "CREATE INDEX IF NOT EXISTS FOR (doc:Doctor) ON (doc.name)",
            ]
            for c in constraints:
                session.run(c)
        _schema_initialized = True
        log.info("Neo4j schema initialized")
    except Exception as e:
        log.warning("Neo4j schema init failed: %s", e)


# ── Patient History Ingestion ──

def ingest_patient_history(patient_context: dict[str, Any]) -> dict:
    """Ingest patient clinical history into Neo4j.

    Creates nodes: Patient, Episode, Diagnosis, Medication, Allergy, Doctor, Facility
    Creates relationships between them.

    Returns summary of nodes/edges created.
    """
    driver = _get_driver()
    if not driver:
        return {"ingested": False, "reason": "neo4j_unavailable"}

    _ensure_schema()

    patient = patient_context.get("patient", patient_context)
    patient_id = (
        patient.get("patient_id")
        or patient.get("protocol_no")
        or ""
    )
    if not patient_id:
        return {"ingested": False, "reason": "no_patient_id"}

    episodes = patient_context.get("episodes", [])

    node_count = 0
    edge_count = 0

    try:
        with driver.session() as session:
            # 1. Patient node
            session.run(
                """
                MERGE (p:Patient {patient_id: $pid})
                SET p.full_name = $name,
                    p.birth_date = $birth,
                    p.updated_at = datetime()
                """,
                pid=str(patient_id),
                name=patient.get("full_name", patient.get("page_title", "")),
                birth=patient.get("birth_date", ""),
            )
            node_count += 1

            # 2. Allergy
            allergy = patient.get("allergy", patient_context.get("allergy"))
            if allergy and isinstance(allergy, dict):
                allergy_swc = allergy.get("AllergySwc", "")
                has_allergy = allergy_swc not in ("F", "")
                session.run(
                    """
                    MERGE (a:Allergy {patient_id: $pid})
                    SET a.has_allergy = $has, a.details = $details
                    WITH a
                    MATCH (p:Patient {patient_id: $pid})
                    MERGE (p)-[:HAS_ALLERGY]->(a)
                    """,
                    pid=str(patient_id),
                    has=has_allergy,
                    details=str({k: v for k, v in allergy.items() if k != "AllergySwc"}),
                )
                node_count += 1
                edge_count += 1

            # 3. Medications
            recipes = patient.get("previous_recipes", [])
            for med in (recipes or []):
                med_name = (
                    med.get("name")
                    or med.get("RecipeName")
                    or med.get("medicine_name")
                    or med.get("MedicineName")
                    or ""
                )
                if not med_name:
                    continue
                session.run(
                    """
                    MERGE (m:Medication {name: $name, patient_id: $pid})
                    SET m.dosage = $dosage
                    WITH m
                    MATCH (p:Patient {patient_id: $pid})
                    MERGE (p)-[:PRESCRIBED]->(m)
                    """,
                    pid=str(patient_id),
                    name=med_name,
                    dosage=med.get("dosage", med.get("Dosage", "")),
                )
                node_count += 1
                edge_count += 1

            # 4. Episodes with diagnoses, doctors, facilities
            for ep in (episodes or []):
                ep_id = str(ep.get("episode_id", ""))
                if not ep_id or ep_id == "0":
                    continue

                date = ep.get("date", "")
                service = ep.get("service_name", "")
                doctor = ep.get("doctor_name", "")
                facility = ep.get("facility_name", "")
                exam_text = (ep.get("examination_text", "") or "")[:500]

                session.run(
                    """
                    MERGE (e:Episode {episode_id: $eid})
                    SET e.date = $date, e.service = $service,
                        e.exam_text = $exam
                    WITH e
                    MATCH (p:Patient {patient_id: $pid})
                    MERGE (p)-[:HAS_EPISODE]->(e)
                    """,
                    eid=ep_id, pid=str(patient_id),
                    date=date, service=service, exam=exam_text,
                )
                node_count += 1
                edge_count += 1

                # Facility
                if facility:
                    session.run(
                        """
                        MERGE (f:Facility {name: $name})
                        WITH f
                        MATCH (e:Episode {episode_id: $eid})
                        MERGE (e)-[:AT_FACILITY]->(f)
                        """,
                        name=facility, eid=ep_id,
                    )
                    node_count += 1
                    edge_count += 1

                # Doctor
                if doctor:
                    session.run(
                        """
                        MERGE (d:Doctor {name: $name})
                        WITH d
                        MATCH (e:Episode {episode_id: $eid})
                        MERGE (e)-[:TREATED_BY]->(d)
                        """,
                        name=doctor, eid=ep_id,
                    )
                    node_count += 1
                    edge_count += 1

                # Department
                if service:
                    session.run(
                        """
                        MERGE (dept:Department {name: $name})
                        WITH dept
                        MATCH (e:Episode {episode_id: $eid})
                        MERGE (e)-[:IN_DEPARTMENT]->(dept)
                        """,
                        name=service, eid=ep_id,
                    )
                    node_count += 1
                    edge_count += 1

                # Diagnoses
                for dx in (ep.get("diagnosis", []) or []):
                    dx_name = dx.get("DiagnosisName", dx.get("diagnosis_name", ""))
                    icd = dx.get("ICDCode", dx.get("icd_code", ""))
                    if not dx_name and not icd:
                        continue
                    session.run(
                        """
                        MERGE (dx:Diagnosis {icd_code: $icd, name: $name})
                        WITH dx
                        MATCH (e:Episode {episode_id: $eid})
                        MERGE (e)-[:HAS_DIAGNOSIS]->(dx)
                        """,
                        icd=icd or dx_name, name=dx_name, eid=ep_id,
                    )
                    node_count += 1
                    edge_count += 1

        log.info(
            "Patient history ingested for %s: %d nodes, %d edges",
            patient_id, node_count, edge_count,
        )
        return {"ingested": True, "nodes": node_count, "edges": edge_count}

    except Exception as e:
        log.error("Patient history ingestion failed: %s", e)
        return {"ingested": False, "reason": str(e)}


# ── Reports Ingestion ──

def ingest_reports(
    patient_id: str,
    manifest: list[dict],
    lab_trends: dict[str, Any] | None = None,
) -> dict:
    """Ingest report manifest and lab trends into Neo4j.

    Creates nodes: Report, ReportType, PACSStudy, LabTest, LabValue
    Links Reports to existing Episodes by episode_id.
    """
    driver = _get_driver()
    if not driver:
        return {"ingested": False, "reason": "neo4j_unavailable"}

    _ensure_schema()

    node_count = 0
    edge_count = 0

    try:
        with driver.session() as session:
            # Ensure patient node exists
            session.run(
                "MERGE (p:Patient {patient_id: $pid})",
                pid=str(patient_id),
            )

            for entry in manifest:
                rid = str(entry.get("report_id", ""))
                if not rid:
                    continue

                rtype = entry.get("report_type", "")
                rtype_swc = entry.get("report_type_swc", "")
                rname = entry.get("report_name", "")
                date = entry.get("date", "")
                facility = entry.get("facility", "")
                approver = entry.get("approver", "")
                ep_id = str(entry.get("episode_id", ""))
                acc_no = entry.get("accession_number")
                has_file = bool(entry.get("file"))
                has_text = bool(entry.get("text_file"))

                # Report node
                session.run(
                    """
                    MERGE (r:Report {report_id: $rid})
                    SET r.name = $name, r.type = $type, r.type_swc = $swc,
                        r.date = $date, r.facility = $facility,
                        r.approver = $approver, r.has_file = $has_file,
                        r.has_text = $has_text, r.file = $file,
                        r.text_file = $text_file
                    WITH r
                    MATCH (p:Patient {patient_id: $pid})
                    MERGE (p)-[:HAS_REPORT]->(r)
                    """,
                    rid=rid, pid=str(patient_id),
                    name=rname, type=rtype, swc=rtype_swc,
                    date=date, facility=facility, approver=approver,
                    has_file=has_file, has_text=has_text,
                    file=entry.get("file", ""),
                    text_file=entry.get("text_file", ""),
                )
                node_count += 1
                edge_count += 1

                # ReportType node
                if rtype:
                    session.run(
                        """
                        MERGE (rt:ReportType {name: $type})
                        SET rt.swc = $swc
                        WITH rt
                        MATCH (r:Report {report_id: $rid})
                        MERGE (r)-[:OF_TYPE]->(rt)
                        """,
                        type=rtype, swc=rtype_swc, rid=rid,
                    )
                    node_count += 1
                    edge_count += 1

                # Facility link
                if facility:
                    session.run(
                        """
                        MERGE (f:Facility {name: $name})
                        WITH f
                        MATCH (r:Report {report_id: $rid})
                        MERGE (r)-[:AT_FACILITY]->(f)
                        """,
                        name=facility, rid=rid,
                    )
                    edge_count += 1

                # Doctor/Approver link
                if approver and approver.strip():
                    session.run(
                        """
                        MERGE (d:Doctor {name: $name})
                        WITH d
                        MATCH (r:Report {report_id: $rid})
                        MERGE (r)-[:APPROVED_BY]->(d)
                        """,
                        name=approver.strip(), rid=rid,
                    )
                    edge_count += 1

                # Episode link (cross-reference between reports and clinical history)
                if ep_id and ep_id != "0" and ep_id != "":
                    session.run(
                        """
                        MERGE (e:Episode {episode_id: $eid})
                        WITH e
                        MATCH (r:Report {report_id: $rid})
                        MERGE (r)-[:IN_EPISODE]->(e)
                        """,
                        eid=ep_id, rid=rid,
                    )
                    edge_count += 1

                # PACS study link
                if acc_no:
                    session.run(
                        """
                        MERGE (ps:PACSStudy {accession_number: $acc})
                        SET ps.report_id = $rid, ps.report_name = $name
                        WITH ps
                        MATCH (r:Report {report_id: $rid})
                        MERGE (r)-[:HAS_PACS]->(ps)
                        """,
                        acc=acc_no, rid=rid, name=rname,
                    )
                    node_count += 1
                    edge_count += 1

            # Ingest lab trends if provided
            if lab_trends:
                _ingest_lab_trends(session, patient_id, lab_trends)

        log.info(
            "Reports ingested for %s: %d manifest entries, %d nodes, %d edges",
            patient_id, len(manifest), node_count, edge_count,
        )
        return {"ingested": True, "reports": len(manifest), "nodes": node_count, "edges": edge_count}

    except Exception as e:
        log.error("Reports ingestion failed: %s", e)
        return {"ingested": False, "reason": str(e)}


def ingest_episodes(
    patient_id: str,
    manifest: list[dict],
) -> dict:
    """Ingest episode manifest (Yatış + Poliklinik) into Neo4j.

    Creates nodes: Hospitalization, Poliklinik (separate from patient Episode nodes)
    Links to existing Patient, Episode, Facility, Doctor, Diagnosis nodes.
    Adds cross-match relationships to Reports when episode_id matches.
    """
    driver = _get_driver()
    if not driver:
        return {"ingested": False, "reason": "neo4j_unavailable"}

    _ensure_schema()

    node_count = 0
    edge_count = 0

    try:
        with driver.session() as session:
            # Ensure patient node exists
            session.run(
                "MERGE (p:Patient {patient_id: $pid})",
                pid=str(patient_id),
            )

            for entry in manifest:
                ep_id = str(entry.get("episode_id", ""))
                if not ep_id:
                    continue

                is_hosp = entry.get("is_hospitalization", False)
                date = entry.get("date", "")
                service = entry.get("service_text", "")
                facility = entry.get("facility_text", "")
                doctor = entry.get("doctor_name", "")

                # Create typed episode node (Hospitalization or Poliklinik)
                node_label = "Hospitalization" if is_hosp else "Poliklinik"
                yb = entry.get("yatis_bilgisi", {}) if is_hosp else {}

                session.run(
                    f"""
                    MERGE (ep:{node_label} {{episode_id: $eid}})
                    SET ep.date = $date, ep.service = $service,
                        ep.facility = $facility, ep.doctor = $doctor,
                        ep.admission_date = $adm_date,
                        ep.discharge_date = $dis_date,
                        ep.admission_reason = $adm_reason,
                        ep.admission_diagnosis = $adm_diag,
                        ep.output_file = $output_file
                    WITH ep
                    MATCH (p:Patient {{patient_id: $pid}})
                    MERGE (p)-[:HAS_{node_label.upper()}]->(ep)
                    """,
                    eid=ep_id, pid=str(patient_id),
                    date=date, service=service,
                    facility=facility, doctor=doctor,
                    adm_date=yb.get("yatis_tarihi", ""),
                    dis_date=yb.get("taburcu_tarihi", ""),
                    adm_reason=yb.get("yatis_sebebi", ""),
                    adm_diag=yb.get("yatis_tanisi", ""),
                    output_file=entry.get("output_file", ""),
                )
                node_count += 1
                edge_count += 1

                # Also MERGE with the generic Episode node for cross-referencing
                session.run(
                    """
                    MERGE (e:Episode {episode_id: $eid})
                    SET e.date = $date, e.service = $service,
                        e.is_hospitalization = $is_hosp
                    """,
                    eid=ep_id, date=date, service=service, is_hosp=is_hosp,
                )

                # Link typed node to generic Episode
                session.run(
                    f"""
                    MATCH (ep:{node_label} {{episode_id: $eid}})
                    MATCH (e:Episode {{episode_id: $eid}})
                    MERGE (ep)-[:IS_EPISODE]->(e)
                    """,
                    eid=ep_id,
                )
                edge_count += 1

                # Facility link
                if facility:
                    session.run(
                        f"""
                        MERGE (f:Facility {{name: $name}})
                        WITH f
                        MATCH (ep:{node_label} {{episode_id: $eid}})
                        MERGE (ep)-[:AT_FACILITY]->(f)
                        """,
                        name=facility, eid=ep_id,
                    )
                    edge_count += 1

                # Doctor link
                if doctor:
                    session.run(
                        f"""
                        MERGE (d:Doctor {{name: $name}})
                        WITH d
                        MATCH (ep:{node_label} {{episode_id: $eid}})
                        MERGE (ep)-[:TREATED_BY]->(d)
                        """,
                        name=doctor, eid=ep_id,
                    )
                    edge_count += 1

                # Diagnosis links
                for dx in entry.get("diagnoses", []):
                    icd = dx.get("icd_code", "")
                    dx_name = dx.get("name", "")
                    if not icd and not dx_name:
                        continue
                    session.run(
                        f"""
                        MERGE (dx:Diagnosis {{icd_code: $icd, name: $name}})
                        WITH dx
                        MATCH (ep:{node_label} {{episode_id: $eid}})
                        MERGE (ep)-[:HAS_DIAGNOSIS]->(dx)
                        """,
                        icd=icd or dx_name, name=dx_name, eid=ep_id,
                    )
                    node_count += 1
                    edge_count += 1

                # Cross-match: link to Reports with same episode_id
                session.run(
                    f"""
                    MATCH (ep:{node_label} {{episode_id: $eid}})
                    MATCH (r:Report)-[:IN_EPISODE]->(e:Episode {{episode_id: $eid}})
                    MERGE (ep)-[:HAS_REPORT]->(r)
                    """,
                    eid=ep_id,
                )

        log.info(
            "Episodes ingested for %s: %d manifest entries, %d nodes, %d edges",
            patient_id, len(manifest), node_count, edge_count,
        )
        return {"ingested": True, "episodes": len(manifest), "nodes": node_count, "edges": edge_count}

    except Exception as e:
        log.error("Episodes ingestion failed: %s", e)
        return {"ingested": False, "reason": str(e)}


def query_episodes_graph(patient_id: str) -> dict:
    """Query the episodes knowledge graph (Yatış + Poliklinik).

    Returns {nodes: [...], edges: [...]} in ReactFlow format.
    """
    driver = _get_driver()
    if not driver:
        return {"nodes": [], "edges": [], "source": "unavailable"}

    try:
        with driver.session() as session:
            result = session.run(
                """
                MATCH (p:Patient {patient_id: $pid})
                OPTIONAL MATCH (p)-[r1]->(h:Hospitalization)
                OPTIONAL MATCH (h)-[r2]->(n2)
                OPTIONAL MATCH (p)-[r3]->(pk:Poliklinik)
                OPTIONAL MATCH (pk)-[r4]->(n4)
                RETURN p, r1, h, r2, n2, r3, pk, r4, n4
                LIMIT 500
                """,
                pid=str(patient_id),
            )
            return _records_to_reactflow(result, "episodes")
    except Exception as e:
        log.error("Episodes graph query failed: %s", e)
        return {"nodes": [], "edges": [], "source": "error", "error": str(e)}


def _ingest_lab_trends(session, patient_id: str, trends: dict):
    """Ingest lab test trends into Neo4j (called within an existing session)."""
    for test_name, values in trends.items():
        if test_name.startswith("_"):
            continue  # Skip meta keys like _abnormal_summary
        if not isinstance(values, list):
            continue

        session.run(
            """
            MERGE (lt:LabTest {name: $name, patient_id: $pid})
            WITH lt
            MATCH (p:Patient {patient_id: $pid})
            MERGE (p)-[:HAS_LAB_TEST]->(lt)
            """,
            name=test_name, pid=str(patient_id),
        )

        for val in values:
            if not isinstance(val, dict):
                continue
            session.run(
                """
                MATCH (lt:LabTest {name: $name, patient_id: $pid})
                CREATE (lv:LabValue {
                    value: $value, unit: $unit,
                    ref_min: $ref_min, ref_max: $ref_max,
                    date: $date, section: $section,
                    is_abnormal: $is_abnormal
                })
                CREATE (lt)-[:HAS_VALUE]->(lv)
                """,
                name=test_name, pid=str(patient_id),
                value=val.get("value"),
                unit=val.get("unit", ""),
                ref_min=val.get("ref_min"),
                ref_max=val.get("ref_max"),
                date=val.get("date", ""),
                section=val.get("section", ""),
                is_abnormal=val.get("is_abnormal", False),
            )


# ── Graph Queries (return ReactFlow-compatible structures) ──

def query_patient_graph(patient_id: str) -> dict:
    """Query the patient history knowledge graph.

    Returns {nodes: [...], edges: [...]} in ReactFlow format.
    """
    driver = _get_driver()
    if not driver:
        return {"nodes": [], "edges": [], "source": "unavailable"}

    try:
        with driver.session() as session:
            result = session.run(
                """
                MATCH (p:Patient {patient_id: $pid})
                OPTIONAL MATCH (p)-[r1]->(n1)
                OPTIONAL MATCH (n1)-[r2]->(n2)
                RETURN p, r1, n1, r2, n2
                LIMIT 500
                """,
                pid=str(patient_id),
            )
            return _records_to_reactflow(result, "patient")
    except Exception as e:
        log.error("Patient graph query failed: %s", e)
        return {"nodes": [], "edges": [], "source": "error", "error": str(e)}


def query_reports_graph(patient_id: str) -> dict:
    """Query the reports knowledge graph.

    Returns {nodes: [...], edges: [...]} in ReactFlow format.
    """
    driver = _get_driver()
    if not driver:
        return {"nodes": [], "edges": [], "source": "unavailable"}

    try:
        with driver.session() as session:
            result = session.run(
                """
                MATCH (p:Patient {patient_id: $pid})-[:HAS_REPORT]->(r:Report)
                OPTIONAL MATCH (r)-[rel]->(n)
                RETURN p, r, rel, n
                LIMIT 500
                """,
                pid=str(patient_id),
            )
            return _records_to_reactflow(result, "reports")
    except Exception as e:
        log.error("Reports graph query failed: %s", e)
        return {"nodes": [], "edges": [], "source": "error", "error": str(e)}


def query_full_graph(patient_id: str) -> dict:
    """Query the full knowledge graph (patient history + reports + cross-refs).

    Returns {nodes: [...], edges: [...]} in ReactFlow format.
    """
    driver = _get_driver()
    if not driver:
        return {"nodes": [], "edges": [], "source": "unavailable"}

    try:
        with driver.session() as session:
            result = session.run(
                """
                MATCH (p:Patient {patient_id: $pid})
                OPTIONAL MATCH path = (p)-[*1..2]-(n)
                UNWIND nodes(path) AS node
                UNWIND relationships(path) AS rel
                RETURN DISTINCT node, rel
                LIMIT 1000
                """,
                pid=str(patient_id),
            )
            return _records_to_reactflow_flat(result)
    except Exception as e:
        log.error("Full graph query failed: %s", e)
        return {"nodes": [], "edges": [], "source": "error", "error": str(e)}


# ── Node label → category mapping for ReactFlow styling ──

_LABEL_CATEGORY = {
    "Patient": "patient",
    "Episode": "episode",
    "Department": "department",
    "Diagnosis": "diagnosis",
    "Medication": "medication",
    "Allergy": "allergy",
    "Doctor": "doctor",
    "Facility": "facility",
    "Report": "report",
    "ReportType": "reportType",
    "PACSStudy": "pacs",
    "LabTest": "labTest",
    "LabValue": "labValue",
    "Hospitalization": "hospitalization",
    "Poliklinik": "poliklinik",
}


def _node_to_dict(node) -> dict:
    """Convert a Neo4j node to a ReactFlow-compatible dict."""
    labels = list(node.labels)
    label = labels[0] if labels else "Unknown"
    category = _LABEL_CATEGORY.get(label, "other")
    props = dict(node)

    # Determine display label
    display = (
        props.get("full_name")
        or props.get("name")
        or props.get("report_name")
        or props.get("icd_code")
        or props.get("accession_number")
        or label
    )

    return {
        "id": str(node.element_id),
        "type": "graphNode",
        "data": {
            "label": str(display),
            "category": category,
            "neo4j_label": label,
            "properties": {k: str(v) for k, v in props.items() if v is not None},
        },
    }


def _records_to_reactflow(records, domain: str) -> dict:
    """Convert Neo4j query records to ReactFlow {nodes, edges} format."""
    nodes_map: dict[str, dict] = {}
    edges_list: list[dict] = []
    edge_ids: set[str] = set()

    for record in records:
        for key in record.keys():
            val = record[key]
            if val is None:
                continue
            if hasattr(val, "labels"):  # Node
                nid = str(val.element_id)
                if nid not in nodes_map:
                    nodes_map[nid] = _node_to_dict(val)
            elif hasattr(val, "type"):  # Relationship
                eid = str(val.element_id)
                if eid not in edge_ids:
                    edge_ids.add(eid)
                    edges_list.append({
                        "id": eid,
                        "source": str(val.start_node.element_id),
                        "target": str(val.end_node.element_id),
                        "label": val.type,
                        "data": {"type": val.type},
                    })

    # Layout nodes in a circle
    nodes = list(nodes_map.values())
    _apply_layout(nodes)

    return {
        "nodes": nodes,
        "edges": edges_list,
        "source": "neo4j",
        "domain": domain,
        "node_count": len(nodes),
        "edge_count": len(edges_list),
    }


def _records_to_reactflow_flat(records) -> dict:
    """Convert flat node/rel records to ReactFlow format."""
    nodes_map: dict[str, dict] = {}
    edges_list: list[dict] = []
    edge_ids: set[str] = set()

    for record in records:
        node = record.get("node")
        rel = record.get("rel")
        if node and hasattr(node, "labels"):
            nid = str(node.element_id)
            if nid not in nodes_map:
                nodes_map[nid] = _node_to_dict(node)
        if rel and hasattr(rel, "type"):
            eid = str(rel.element_id)
            if eid not in edge_ids:
                edge_ids.add(eid)
                edges_list.append({
                    "id": eid,
                    "source": str(rel.start_node.element_id),
                    "target": str(rel.end_node.element_id),
                    "label": rel.type,
                    "data": {"type": rel.type},
                })

    nodes = list(nodes_map.values())
    _apply_layout(nodes)

    return {
        "nodes": nodes,
        "edges": edges_list,
        "source": "neo4j",
        "domain": "full",
        "node_count": len(nodes),
        "edge_count": len(edges_list),
    }


def _apply_layout(nodes: list[dict]):
    """Apply a radial layout to nodes based on category.

    Patient node at center, others in concentric rings by category.
    """
    import math

    category_order = [
        "patient", "department", "episode", "diagnosis",
        "medication", "allergy", "doctor", "facility",
        "report", "reportType", "pacs", "labTest", "labValue",
        "hospitalization", "poliklinik", "other",
    ]

    ring_radius = {
        "patient": 0,
        "department": 300, "episode": 500,
        "diagnosis": 650, "medication": 350,
        "allergy": 300, "doctor": 400, "facility": 400,
        "report": 350, "reportType": 550,
        "pacs": 650, "labTest": 450, "labValue": 600,
        "hospitalization": 400, "poliklinik": 500,
        "other": 500,
    }

    # Group by category
    groups: dict[str, list[dict]] = {}
    for n in nodes:
        cat = n.get("data", {}).get("category", "other")
        if cat not in groups:
            groups[cat] = []
        groups[cat].append(n)

    # Assign angular positions
    angle_offset = 0.0
    for cat in category_order:
        if cat not in groups:
            continue
        group = groups[cat]
        radius = ring_radius.get(cat, 500)

        if cat == "patient":
            for n in group:
                n["position"] = {"x": 0, "y": 0}
            continue

        angle_step = (2 * math.pi) / max(len(group), 1)
        for i, n in enumerate(group):
            angle = angle_offset + angle_step * i
            n["position"] = {
                "x": round(math.cos(angle) * radius),
                "y": round(math.sin(angle) * radius),
            }
        angle_offset += 0.4  # Offset each category ring slightly
