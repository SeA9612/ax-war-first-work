# 원본 데이터 복사본 (data/source)

- 출처: `01_참가자_배포용/04_원본데이터/` (대회 제공 원본, 읽기 전용)
- 복사일: 2026-11-11 (실제 작업일. 가상기업 기준일은 2026-07-01)
- 처리: 아래 파일을 **내용 무수정**으로 같은 상대경로에 복사(cp -p). 배포 이미지에는 원본 폴더가 없으므로 앱은 이 복사본만 읽는다.
- 검증: 복사 직후 원본과 `cmp` 바이트 비교 일치. SHA-256은 아래 표(앱 `/api/sources` 화면에서도 확인).
- 판정 정정·회신 등 운영 입력은 이 파일을 바꾸지 않고 `data/state.json`의 오버레이로 기록한다.

| 경로(04_원본데이터 기준) | SHA-256 |
|---|---|
| 00_common/approval_authority_policy.md | 889f7eb5018b455f05e9c934686c4926e97ef7624d5405975a3eedc5b107769d |
| 00_common/calculation_definitions.md | 8a62b6f6752eb2f2f1a465aa2b95028fb78f8008d5b201407c269525eaf48ece |
| 01_corevia/docs/rfp_c201.md | b495d4dafc23889efd3797664b49de64af584b75152ddd749b6ef0a92e060747 |
| 01_corevia/financials/fin_ar_aging_cv.csv | b5abb8731b9711096df1651c19a80a2610aff63b2034ccb464eb430ddc1c8705 |
| 01_corevia/master/m_customer_cv.csv | 451944a7bf1b77863e53c31fc222b014f84c7baa36b678ab2e6b9c8bc3701bf0 |
| 01_corevia/master/m_material_cv.csv | be05f5dd87eaa1443e95da0322cae5007ba89579af91aa3b3b512b5b5e6b30db |
| 01_corevia/master/m_product_cv.csv | a4c6a68ca499fcd5667b45d4b4737cc7d46d430a685267e1f6eaaf54cf496bf6 |
| 01_corevia/procurement/material_lot_master_cv.csv | af28bc7e8946b0c3135ac841b9f097095a68e453960e638dce7e3c00b5632db7 |
| 01_corevia/production/prod_batch_log_cv.csv | 6c49f0268bd75c21dee53bb8e7c6cedffcf825b836f1d42c822671fb1ebab408 |
| 01_corevia/production/strat_capacity_cv.csv | d8bff0e267868a1d736dfd309dc67ae5c9a46c73d98136c406f7f9df73b99636 |
| 01_corevia/quality/qc_claims_cv.csv | 97ab9691178f36ba5e6aae5dbe3004f767187500f2ed8ad6eb604d2e11c5b248 |
| 01_corevia/quality/quality_policy_cv.md | 352b77edaf66a4dd3bbb368ec9c778652898262bdc37761a70db51d401526a74 |
| 01_corevia/quality/shipment_batch_link_cv.csv | 89a39a1774779ea6917ec0559007818c80067f29b68e44fb26a5d9d249afa01a |
| 01_corevia/sales/sales_orders_cv.csv | 1f0d49d7aca7c4550d378fd772155e4abf213218a166902a72a71423eed26d0e |
| 01_corevia/sales/sales_shipments_cv.csv | 86553f47628b0fa550af9b532b3d9ad5f1b778cc165e696544de34ae96dfed09 |
| 02_masil/inventory/sc_purchase_orders_ms.csv | 2686b7e51395ff487b5cb37d7fe1a6f2f20c4ff77acea8164bee5e32918ebd44 |
| 02_masil/inventory/sku_inventory_ms.csv | 5ee7162933b1e30d779625ce5c384b8acc1d6e51636c083f49aaa6dab02548f8 |
| 02_masil/master/m_sku_ms.csv | 7df809c41142d702e09be67b510a65e6c638d59f1f0c43eb2d231c934faf1c64 |
| 05_external/news/ext_news_quality_incident.md | f2bc4314362dae8574e13c5578466cbe50e434ea703f7d95a9dbd805dbd1eadd |

> 이 공개 저장소에는 위 파일들의 내용이 들어 있지 않습니다(대회 원본 재배포 금지). 같은 경로에 대회 원본을 넣으면 앱과 테스트가 동작합니다.
