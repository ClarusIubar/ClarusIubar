# ClarusIubar

`ClarusIubar` 계정은 흩어진 코드, 문서, 작업 규칙을 재사용 가능한 시스템으로 바꾸는 작업을 중심으로 운영하고 있습니다.

기준 시점: 2026-05-13
- 총 레포: 111
- 직접 운영 레포: 67
- 포크 레포: 44

## 지금 푸는 문제

- 포크와 개인 코드에 흩어진 구조를 그대로 쌓지 않고, 공용 모듈로 추출하는 문제
- 에이전트 작업이 issue, branch, checklist, context 없이 흐트러지는 문제
- 데이터 수집과 분석 코드가 한 번 실행되고 끝나는 스크립트로 남는 문제
- 제품 레포가 커질수록 화면, API, 배포 경계가 흐려지는 문제

## 대표 레포와 역할

- `library`
  - 개인 코드와 포크 자산에서 재사용 가능한 모듈을 추출하고, 테스트와 마이그레이션 기록까지 같이 관리하는 저장소
- `agent_bootstrap`
  - 에이전트가 이슈, 브랜치, 체크리스트, active context를 일관되게 따르도록 만드는 로컬 거버넌스 도구
- `seek_my_document`
  - 개인 문서, 노트, 지식베이스를 검색하고 retrieval 흐름으로 연결하는 실험 저장소
- `etf_rebound_discovery`
  - ETF 리바운드 후보를 찾기 위한 수집, 정규화, 상태 전이, 실행 기록 파이프라인 저장소
- `autotrade_old` / `autotrade_renew`
  - 자동매매 전략과 운영 흐름을 구조화하고 다시 설계하는 퀵트 저장소
- `JamIssue`
  - 사용자가 실제로 쓰는 제품에서 모바일/웹 구성, API 호환성, 배포 기준을 정리하는 앱 저장소
- `dandelion`
  - 하루에 한 번만 감정을 기록하게 해 말의 무게를 보존하는 감정 아카이브 시스템
- `Octopus`
  - 선택을 돕는 UI/로직을 제품화하는 의사결정 보조 실험 저장소
- `news`
  - 뉴스를 크롤링하고 n8n 웹훅으로 전달하는 로컬 자동화 저장소
- `docker-setup`
  - runner, compose, 로컬 운영 환경에서 쓰는 도커 공통 분모를 정리하는 인프라 저장소

## 포크는 관심사 레이어

- 포크는 내 주력 작업 자체라기보다, 구조와 아이디어를 참조하는 관심사 레이어로 분리해 두고 있습니다.
- 주로 보는 포크: `paperclip`, `symphony`, `codex`, `opencode`, `openclaw`, `qmd`, `GitNexus`, `firecrawl`, `memori`, `Agentic-R`, `ReasonRank`, `camel`, `vllm`
- 여기에서 방향과 구조를 참조하고, 실제 운영 코드는 비포크 레포에서 만듭니다.

## Contribution Graph

![](./profile-3d-contrib/profile-night-view.svg)

## Languages

<p align="center">
  <img src="./metrics/metrics.languages.svg" width="72%" alt="language metrics" />
</p>
